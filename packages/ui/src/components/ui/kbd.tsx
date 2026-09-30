import { cn } from "@/components/lib/utils.js";

/**
 * Keycap assembly (aligned shadcn Kbd): each key is independently chipped, fixed height + minimum square width +
 * flex is centered to ensure that single symbol keys such as ⌘/⇧ have the same visual size as letter keys; font-sans prevents symbols from
 * Variation in glyph width caused by the fallback of monospaced fonts (data comes from platform formatted labels, see shortcuts/label.ts).
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 select-none items-center justify-center gap-1 rounded-sm bg-muted px-1 font-sans text-ui-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** Keycap combination container: Arrange multiple keys in one combination horizontally (gap-1), such as ⌘ + K. */
function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
