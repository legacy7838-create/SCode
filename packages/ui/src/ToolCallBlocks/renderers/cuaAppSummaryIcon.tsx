import { useEffect, useState, type ReactNode } from "react";
import type { ApplicationIconRequest } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { CUA_TOOL_ICON } from "@/ToolCallBlocks/renderers/cuaIcon.js";

export function CuaAppSummaryIcon({
  bundleId,
  fallback,
  iconRequest,
  name,
  className,
}: {
  bundleId?: string;
  /**
   * What is displayed when the icon cannot be obtained (the platform has no resolver, Linux has no locator, and the reading fails).
   * The CUA icon is used by default; the node_repl tool card passes in its own icon to prevent the same card from parsing failure.
   * Jump to another pointer shape.
   */
  fallback?: ReactNode;
  iconRequest?: ApplicationIconRequest | string | null;
  name: string;
  className?: "size-4" | "size-5";
}) {
  const platform = useOptionalPlatform();
  const [iconDataUrl, setIconDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setIconDataUrl(null);
    const request = iconRequest ?? bundleId;
    if (!request || !platform?.getApplicationIcon) return () => undefined;
    void platform
      .getApplicationIcon(request)
      .then((result) => {
        if (active) setIconDataUrl(result?.iconDataUrl ?? null);
      })
      .catch(() => {
        if (active) setIconDataUrl(null);
      });
    return () => {
      active = false;
    };
  }, [bundleId, iconRequest, platform]);

  return iconDataUrl ? (
    <img
      src={iconDataUrl}
      alt={name}
      className={cn(className ?? "size-4", "shrink-0 rounded-sm object-contain")}
    />
  ) : (
    (fallback ?? CUA_TOOL_ICON)
  );
}
