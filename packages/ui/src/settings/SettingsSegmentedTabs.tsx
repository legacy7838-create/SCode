import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";

interface SettingsSegmentedTabItem<TValue extends string> {
  label: string;
  value: TValue;
}

/**
 * Compact segmented control shared by the settings detail pages, so the same level does not end up
 * with several different Tabs looks.
 */
export function SettingsSegmentedTabs<TValue extends string>({
  items,
  value,
  onValueChange,
}: {
  items: readonly SettingsSegmentedTabItem<TValue>[];
  value: TValue;
  onValueChange: (value: TValue) => void;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as TValue)}
      className="gap-0"
    >
      <TabsList className="flex h-8 rounded-full bg-surface p-0.5 group-data-horizontal/tabs:h-8">
        {items.map((item) => (
          <TabsTrigger
            key={item.value}
            value={item.value}
            className="h-7 flex-none rounded-full border-transparent bg-transparent px-2.5 text-ui-base font-medium text-foreground-subtle data-active:border-transparent data-active:bg-background data-active:text-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-background"
          >
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
