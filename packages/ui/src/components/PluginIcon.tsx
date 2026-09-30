import { useState, type ReactNode } from "react";
import { Blocks } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { resolvePluginIconSource } from "@/lib/pluginIconSource.js";

/**
 * The plugin's original icon; supports official built-in icons and HTTPS, and uses the
 * caller-supplied fallback when missing or failing, defaulting to Blocks.
 */
export function PluginIcon({
  src,
  pluginId,
  className,
  iconClassName,
  fallbackIcon,
}: {
  src?: string;
  pluginId?: string;
  className?: string;
  iconClassName?: string;
  fallbackIcon?: ReactNode;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const resolvedSrc = resolvePluginIconSource(pluginId, src);
  const showImage = Boolean(resolvedSrc) && !imageFailed;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-xl bg-surface",
        !showImage && "text-foreground-subtle",
        className,
      )}
    >
      {showImage ? (
        <img
          src={resolvedSrc}
          alt=""
          draggable={false}
          className="h-2/3 w-2/3 object-contain"
          onError={() => setImageFailed(true)}
        />
      ) : fallbackIcon ? (
        fallbackIcon
      ) : (
        <Blocks className={cn("size-4", iconClassName)} />
      )}
    </span>
  );
}
