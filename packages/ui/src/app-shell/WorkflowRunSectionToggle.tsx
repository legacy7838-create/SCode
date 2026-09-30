import { type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";

/**
 * The header bar for the collapsible sections of the workflow run detail page.
 *
 * The pending-questions section and the artifacts section share this one bar: their collapse
 * semantics are exactly the same, and writing each one separately would sooner or later drift apart
 * in corner radius, hover colour or chevron angle. The prototype is the toggle the Script section
 * used back then (extracted from it as-is), so this bar **introduces no new visual vocabulary**.
 * The Results / event log / Script sections have been removed; the two remaining callers have
 * opposite default states (questions collapsed, artifacts expanded), and that is each section's own
 * business, not this component's.
 *
 * The header is only responsible for "the act of opening and closing": fetching the body data, its
 * gating and its layout all stay with each section.
 *
 * **Deliberately not memoized**: its callers are themselves memo components that only re-render
 * when their own state or projection changes — at which point this bar's
 * `expanded`/`label`/`trailing` have changed too. Wrapping it in memo would only force `onToggle`
 * and `trailing` into `useCallback`/`useMemo` (which the reactStableReferences guard demands), in
 * exchange for a comparison that could never hit.
 */
export function WorkflowRunSectionToggle({
  expanded,
  label,
  onToggle,
  testId,
  title,
  trailing,
}: {
  expanded: boolean;
  /**
   * aria-label: "Expand X" / "Collapse X" depending on the current state; the title itself is
   * carried by `title`.
   */
  label: string;
  onToggle: () => void;
  testId: string;
  title: string;
  /**
   * Supplementary information on the right of the header bar (counts, loading hints, etc.). It is
   * present while collapsed too — collapsing must not make "whether this section has anything in it
   * at all" invisible.
   */
  trailing?: ReactNode;
}) {
  return (
    <button
      aria-expanded={expanded}
      aria-label={label}
      className="flex w-full items-center gap-1.5 px-4 py-2 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40"
      data-testid={testId}
      onClick={onToggle}
      type="button"
    >
      <ChevronRightIcon
        className={cn(
          "size-3.5 shrink-0 text-foreground-subtlest transition-transform",
          expanded ? "rotate-90" : undefined,
        )}
      />
      <span className="min-w-0 flex-1 truncate text-ui-xs font-medium text-foreground-subtle">
        {title}
      </span>
      {trailing}
    </button>
  );
}
