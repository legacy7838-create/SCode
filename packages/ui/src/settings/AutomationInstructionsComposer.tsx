import {
  useCallback,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type InputEvent,
  type ReactNode,
} from "react";
import { cn } from "@/components/lib/utils.js";

const AUTOMATION_INSTRUCTIONS_MIN_HEIGHT_PX = 116;
const AUTOMATION_INSTRUCTIONS_MAX_HEIGHT_PX = 156;

interface AutomationInstructionsComposerProps {
  invalid?: boolean;
  children: ReactNode;
}

/**
 * The single interaction contract for the feature triggers at the bottom of Instructions. The
 * scheduled and idle-time forms used to maintain their expanded state through hover, focus-within
 * and different corner radii respectively, so the same feature showed inconsistent pill /
 * rounded-square corners and open backgrounds across the two automation kinds. The line height uses
 * a rem-based semantic class, because a fixed pixel value would compress the text line box after
 * the interface font size is adjusted.
 */
export const AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME =
  "h-7 rounded-full text-ui-base font-normal leading-5 text-foreground-subtle hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground";

/**
 * The input content on both the scheduled and idle-time settings pages uniformly uses the 14px body
 * font size. The two pages used to maintain the title, schedule and Instructions font sizes
 * separately, and some hourly-schedule branches fell back to 12px.
 */
export const AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME = "text-ui-base leading-5";

/**
 * The composite Instructions input shared by Automations. The textarea itself carries the standard
 * Input outline, and the parent only supplies the toolbar's surface layer. Geometry, surface
 * layering and the global Input outline state are all funneled through here; callers only provide
 * field state and toolbar content.
 */
export function AutomationInstructionsComposer({
  invalid = false,
  children,
}: AutomationInstructionsComposerProps) {
  return (
    <div
      data-invalid={invalid || undefined}
      className="flex min-h-39 flex-col overflow-hidden rounded-xl border-0 bg-surface @container/composer"
    >
      {children}
    </div>
  );
}

export function AutomationInstructionsTextarea({
  rows = 5,
  onInput,
  value,
  ...props
}: Omit<ComponentProps<"textarea">, "className" | "ref">) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAutomaticHeightRef = useRef<number | null>(null);
  const resizeToContent = useCallback((textarea: HTMLTextAreaElement) => {
    const currentHeight = Number.parseFloat(textarea.style.height);
    const lastAutomaticHeight = lastAutomaticHeightRef.current;
    const hasManualHeight =
      lastAutomaticHeight !== null &&
      Number.isFinite(currentHeight) &&
      Math.abs(currentHeight - lastAutomaticHeight) > 1;
    const contentHeight = textarea.scrollHeight;

    // Auto-height used to unconditionally rewrite height every time it was entered, and the height after dragging by desktop users would be lost immediately.
    // When the manual height is inconsistent with the last automatic height, only internal scrolling is maintained and the user-selected size is no longer covered.
    if (hasManualHeight) {
      textarea.style.overflowY = contentHeight > currentHeight ? "auto" : "hidden";
      return;
    }

    // Automatic heightening is maintained when manual dragging does not occur: short content returns to 116px, and about 7 lines are capped at 156px.
    // Longer content only scrolls inside the text area.
    textarea.style.height = `${AUTOMATION_INSTRUCTIONS_MIN_HEIGHT_PX}px`;
    const automaticHeight = Math.min(
      Math.max(contentHeight, AUTOMATION_INSTRUCTIONS_MIN_HEIGHT_PX),
      AUTOMATION_INSTRUCTIONS_MAX_HEIGHT_PX,
    );
    textarea.style.height = `${automaticHeight}px`;
    lastAutomaticHeightRef.current = automaticHeight;
    textarea.style.overflowY =
      contentHeight > AUTOMATION_INSTRUCTIONS_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    if (textareaRef.current) {
      resizeToContent(textareaRef.current);
    }
  }, [resizeToContent, value]);

  const handleInput = (event: InputEvent<HTMLTextAreaElement>) => {
    resizeToContent(event.currentTarget);
    onInput?.(event);
  };

  return (
    <textarea
      {...props}
      ref={textareaRef}
      value={value}
      rows={rows}
      onInput={handleInput}
      className={cn(
        "h-29 min-h-29 max-h-39 shrink-0 resize-none overflow-y-hidden rounded-xl border border-input-border bg-input p-3 text-foreground outline-none transition-colors placeholder:text-ui-base placeholder:text-foreground-subtlest hover:border-input-border-hover focus:border-input-border-focused focus:bg-input-focused focus:outline-none aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
        AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,
      )}
    />
  );
}

export function AutomationInstructionsToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-0 p-1.5 sm:h-10 sm:flex-nowrap">
      {children}
    </div>
  );
}
