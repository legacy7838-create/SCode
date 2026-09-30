import { MousePointerClick } from "lucide-react";

export const CUA_FALLBACK_ICON = (
  <MousePointerClick className="size-4 shrink-0 text-foreground-subtle" />
);

// Semantic names compatible with CUA grouping summaries; the underlying visual still uses the same fallback.
export const CUA_TOOL_ICON = CUA_FALLBACK_ICON;
