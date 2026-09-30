import { PluginIcon } from "@/components/PluginIcon.js";
import type { MentionItem } from "@/mentions/mentionTypes.js";

export function PluginMentionOptionContent({ item }: { item: MentionItem }) {
  return (
    <span className="min-w-0 flex flex-1 items-center gap-2">
      <PluginIcon
        pluginId={item.data?.pluginId ?? item.value}
        src={item.data?.icon}
        className="size-5 rounded-md"
        iconClassName="size-3"
      />
      <span className="shrink-0 whitespace-nowrap text-ui-base font-medium text-foreground">
        {item.displayLabel ?? item.label}
      </span>
      <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
        {/* Conflict disabled items display the reason first, and ordinary items display the plug-in description in the current language. */}
        {item.disabled && item.disabledReason ? item.disabledReason : item.description}
      </span>
    </span>
  );
}
