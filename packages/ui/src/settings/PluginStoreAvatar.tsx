import type { ReactNode } from "react";
import { PluginIcon } from "@/components/PluginIcon.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";

/**
 * Store entry avatar: listing.icon (https only) takes priority, and when loading fails or the icon
 * is missing it degrades to a neutral Blocks icon inside a rounded `bg-surface` square container,
 * so that icon-less plugins do not add too much accent color, while keeping the same outer shape as
 * a real icon and preventing a circular/square visual jump when the image fails to load. The
 * design's icon asset is only the graphic itself; the outer semantic container carries the themed
 * background. Applying dark:invert to the whole image would invert brand colors such as Android
 * green, so the asset keeps its original colors here.
 */
export function PluginStoreAvatar({
  item,
  className,
  iconClassName,
  fallbackIcon,
}: {
  item: Pick<StorePluginItem, "name" | "listing"> & Partial<Pick<StorePluginItem, "id">>;
  className?: string;
  iconClassName?: string;
  fallbackIcon?: ReactNode;
}) {
  return (
    <PluginIcon
      src={item.listing?.icon}
      pluginId={item.id}
      className={className}
      iconClassName={iconClassName}
      fallbackIcon={fallbackIcon}
    />
  );
}
