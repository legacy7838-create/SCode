import { useEffect, useState, type ReactNode } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import { dynamicIconImports, type IconName } from "lucide-react/dynamic.mjs";

interface ClientSceneLucideIconProps extends Omit<LucideProps, "children"> {
  fallback: ReactNode;
  name?: string;
}

function isLucideIconName(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(dynamicIconImports, name);
}

/**
 * Loads the icon by the Lucide canonical name shipped from Client Scenes; an unknown name keeps the
 * caller's semantic fallback.
 */
export function ClientSceneLucideIcon({
  fallback,
  name,
  ...iconProps
}: ClientSceneLucideIconProps) {
  const normalizedName = name?.trim();
  const [resolved, setResolved] = useState<{
    Icon: LucideIcon;
    name: IconName;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!normalizedName || !isLucideIconName(normalizedName)) return undefined;

    void dynamicIconImports[normalizedName]()
      .then((iconModule) => {
        if (!cancelled) {
          setResolved({ Icon: iconModule.default, name: normalizedName });
        }
      })
      .catch(() => {
        if (!cancelled) setResolved(null);
      });

    return () => {
      cancelled = true;
    };
  }, [normalizedName]);

  if (!normalizedName || resolved?.name !== normalizedName) return fallback;

  const Icon = resolved.Icon;
  return <Icon {...iconProps} data-client-scene-lucide-icon={normalizedName} />;
}
