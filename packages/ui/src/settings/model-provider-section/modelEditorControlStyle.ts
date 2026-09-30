import { cn } from "@/components/lib/utils.js";

/**
 * Model-editor only: the border marks an override only, hover/focus reuse the same base color, and
 * site-wide controls are left untouched.
 */
export function modelEditorControlStyle(overridden: boolean, selected?: boolean) {
  return cn(
    "outline-none focus-visible:ring-0",
    overridden
      ? "border-primary/35 hover:border-primary/35 focus-visible:border-primary/35"
      : "border-border hover:border-border focus-visible:border-border",
    // The light color selected and hover are originally the same 5%, and no change can be seen after clicking; only the background color of the box is enhanced, and the covering border remains unchanged.
    selected === true
      ? "bg-foreground/15 bg-clip-border hover:bg-foreground/20 focus-visible:bg-foreground/20"
      : selected === false
        ? "bg-transparent hover:bg-hover focus-visible:bg-hover"
        : "bg-input hover:bg-hover focus-visible:bg-hover",
  );
}
