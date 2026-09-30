/**
 * Small parts shared by the four preset renderers: the `labels` contract, empty states, field
 * labels, and the reveal-animation class names.
 *
 * These components **never touch i18n**: the run side panel and the `workflow-artifact` tab each
 * hold their own intl and pass already-translated copy in through `labels`. The reason is that a
 * renderer has to be reusable from the side panel, the tab and the (future) hub detail page; what
 * each context calls something is the caller's decision, whereas a component that looks up message
 * ids itself would weld those three call sites together.
 */

import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

/**
 * The three translated strings the caller must supply (every other string comes from the label /
 * title the author wrote in the spec).
 */
export type PresetLabels = {
  /** The name of the board column that catches “statuses not listed in columns”. */
  otherColumn: string;
  /** The message shown when not a single row of data has arrived yet. */
  empty: string;
  /** “N items” — table row count, board card count. */
  itemsCount: (count: number) => string;
};

/**
 * The reveal animation for a new element. A stable React key plus playing it only once on
 * **mount**, so existing points do not replay as new ones arrive; under `motion-reduce` it is
 * turned off entirely.
 */
export const REVEAL_ANIMATION_CLASS =
  "animate-in fade-in duration-300 ease-out motion-reduce:animate-none";

/**
 * Placeholder for when there is no data at all. Kept at the lowest possible presence: a board is
 * empty at first during its run anyway.
 */
export function PresetEmpty({ label, compact }: { label: string; compact?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-lg border border-dashed border-border text-foreground-subtlest",
        compact ? "px-2 py-3 text-ui-xs" : "px-4 py-8 text-ui-sm",
      )}
      data-testid="artifact-preset-empty"
    >
      {label}
    </div>
  );
}

/**
 * The one way to write a field name + unit: the unit goes in parentheses after the label instead of
 * being repeated on every value (dataviz convention).
 */
export function fieldHeading(label: string, unit?: string): string {
  return unit ? `${label} (${unit})` : label;
}

/**
 * The title bar in its full-size form: the spec's title / description are written by the author in
 * the user's language and are rendered here as-is. When none of the three exist the whole block is
 * **absent** (its margin disappears too) — so the margin is carried here rather than by the caller
 * wrapping an extra div.
 */
export function PresetHeading({
  title,
  description,
  trailing,
  className,
}: {
  title?: string;
  description?: string;
  trailing?: ReactNode;
  className?: string;
}) {
  if (!title && !description && !trailing) {
    return null;
  }
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        {title ? (
          <div className="truncate text-ui-base font-medium text-foreground">{title}</div>
        ) : null}
        {description ? (
          <div className="mt-0.5 text-ui-sm text-foreground-subtle">{description}</div>
        ) : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
}
