import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const mergeUiClasses = extendTailwindMerge({
  extend: {
    classGroups: {
      // text-ui-* is the font size rather than text color; register it explicitly to avoid overwriting each other with color classes such as text-foreground.
      "font-size": [
        "text-ui-xl",
        "text-ui-lg",
        "text-ui-base",
        "text-ui-caption",
        "text-ui-sm",
        "text-ui-xs",
        "text-mobile-input-safe",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return mergeUiClasses(clsx(inputs));
}
