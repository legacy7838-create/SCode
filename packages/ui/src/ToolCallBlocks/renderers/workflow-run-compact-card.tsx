import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  RUN_STATUS_DOT,
  RUN_STATUS_TEXT,
} from "@/components/workflow-graph/run-status-presentation.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";

function isInteractiveDescendant(target: EventTarget | null, card: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest("button, a, input, textarea, select, [role='button']");
  // The card itself has role=button, closest will make the card hit itself anywhere, so "click the card to open the details"
  // It will never be executed (the original bug of the plan card). Only real child controls are intercepted here.
  return interactive !== null && interactive !== card;
}

/**
 * The compact clickable card for a workflow run — the "third run state" shared by the
 * CreateWorkflow and ResumeWorkflowRun tool cards.
 *
 * The whole card is the entry point (DESIGN.md semantic colors + the existing run state
 * vocabulary): the discoverability failures we measured happened precisely because the entry point
 * used to be buried inside the expanded card body. The two call sites only swap labelText and
 * primaryText (create uses the workflow name, resume uses runId), while the state dot word and the
 * step count are both driven live by the joined summary.
 *
 * A missing `onOpen` means pure display mode: no role/tabIndex/hover is added — the host only
 * injects the callback when there really is an openable run (the gating semantics of
 * `ToolCallBlockRenderContext.onOpenWorkflowRun`).
 */
export function WorkflowRunCompactCard({
  ariaLabel,
  icon,
  labelText,
  primaryText,
  primaryTitle,
  workflowRun,
  statusLabel,
  stepsLabel,
  onOpen,
  showIcon,
  children,
}: {
  ariaLabel: string;
  icon: ReactNode;
  labelText: string;
  primaryText: string;
  primaryTitle?: string;
  workflowRun: WorkflowRunCardSummary;
  statusLabel: string;
  stepsLabel: string;
  onOpen: (() => void) | undefined;
  showIcon: boolean;
  /**
   * The extra content below the card (e.g. ToolSnapshotFieldNotice); it is rendered with the card.
   */
  children?: ReactNode;
}) {
  // Click / Enter / Space for the whole card - follow the plan card idiom of switch-mode.tsx verbatim, including two reasons for guarding:
  // The card itself has role=button, so the card itself must be excluded from the judgment, otherwise "click the card to open details" will never be executed;
  // The keydown of the sub-control will continue to bubble up to the entire card, and one keyboard operation will open the details page twice.
  const handleCardClick = (event: MouseEvent<HTMLElement>) => {
    if (!onOpen) return;
    if (!isInteractiveDescendant(event.target, event.currentTarget)) onOpen();
  };
  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!onOpen) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    if (isInteractiveDescendant(event.target, event.currentTarget)) return;
    event.preventDefault();
    onOpen();
  };

  return (
    <>
      <section
        aria-label={ariaLabel}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-xl border border-card-border bg-card px-3 py-2.5 text-foreground shadow-xs outline-none transition-colors",
          onOpen
            ? "hover:border-border-hover focus-visible:border-input-border-focused focus-visible:ring-2 focus-visible:ring-ring/40"
            : undefined,
        )}
        data-testid="workflow-run-card"
        data-workflow-run-id={workflowRun.runId}
        data-workflow-run-status={workflowRun.status}
        onClick={handleCardClick}
        onKeyDown={handleCardKeyDown}
        role={onOpen ? "button" : undefined}
        tabIndex={onOpen ? 0 : undefined}
      >
        {showIcon ? icon : null}
        <span className="shrink-0 text-ui-base font-medium text-foreground-subtle">
          {labelText}
        </span>
        {/* The workflow name is a UI heading, so it uses the default font instead of being shown as code in a monospace font. */}
        <span
          className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtlest"
          title={primaryTitle ?? primaryText}
        >
          {primaryText}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {/* The state word always sits next to the dot: state is never conveyed by color or animation alone. */}
          <span
            aria-hidden="true"
            className={cn("size-1.5 shrink-0 rounded-full", RUN_STATUS_DOT[workflowRun.status])}
          />
          <span className={cn("text-ui-sm", RUN_STATUS_TEXT[workflowRun.status])}>
            {statusLabel}
          </span>
        </span>
        {/* The step count is "how many of the scheduled ones have settled", not a whole-run percentage — a dynamic workflow has no static total. */}
        <span className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          {stepsLabel}
        </span>
      </section>
      {children}
    </>
  );
}
