/* Off-peak task list:
   a 2-column card grid whose card structure comes from the same source as the scheduled-task card:
   title + prompt description + footer (moon + #N in queue position badge). Sorted newest-first by
   creation time; the hover menu is narrowed by status. Positions have no Est.
   */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from "react";
import { CircleCheck, Loader2, TriangleAlert } from "lucide-react";
import {
  TID_OFFPEAK_ACTION_CONTINUE,
  TID_OFFPEAK_ACTION_DELETE,
  TID_OFFPEAK_ACTION_PAUSE,
  TID_OFFPEAK_CARD,
  TID_OFFPEAK_CARD_SESSION,
  TID_OFFPEAK_CARD_MENU,
  type ZCodeOffPeakTask,
} from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  AutomationCancelActionIcon,
  AutomationContinueIcon,
  AutomationExternalLinkIcon,
  AutomationIdleTimeIcon,
  AutomationInfoIcon,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationPausedIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import {
  resolveFailedOffPeakQueueFooter,
  resolveOffPeakStatusFooter,
  shouldShowOffPeakModelSelectionIssue,
  type OffPeakStatusIconKind,
} from "@/settings/offPeakUiPresentation.js";

interface OffPeakTaskListProps {
  tasks: readonly ZCodeOffPeakTask[];
  busyOperationId: string | null;
  onOpen: (task: ZCodeOffPeakTask) => void;
  onPause: (task: ZCodeOffPeakTask) => void;
  onContinue: (task: ZCodeOffPeakTask) => void;
  onCancel: (task: ZCodeOffPeakTask) => void;
  onDelete: (task: ZCodeOffPeakTask) => void;
  onOpenSession: (task: ZCodeOffPeakTask) => void;
}

// Grouping by state will cause tasks to jump when switching between running and final states, destroying the user's expectations of the location of existing cards;
// The list is only ordered in reverse order by immutable creation time, and state changes no longer affect the order.
function sortOffPeakTasksByCreatedAt(tasks: readonly ZCodeOffPeakTask[]): ZCodeOffPeakTask[] {
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The same scroll threshold as the scheduled-task list in AutomationsSection (the design spec
 * allows at most 8 cards to show).
 */
const OFFPEAK_LIST_SCROLL_THRESHOLD = 8;

const OFFPEAK_MENU_HINT_MAX_WIDTH = 320;
const OFFPEAK_MENU_HINT_RIGHT_OFFSET = 16;

type OffPeakMenuHintSide = "right" | "top";

function resolveOffPeakMenuHintSide(
  triggerRect: Pick<DOMRect, "right"> | null,
  viewportWidth: number,
): OffPeakMenuHintSide {
  if (!triggerRect) {
    return "top";
  }
  return viewportWidth - triggerRect.right >=
    OFFPEAK_MENU_HINT_MAX_WIDTH + OFFPEAK_MENU_HINT_RIGHT_OFFSET
    ? "right"
    : "top";
}

function OffPeakMenuHint({ children, title }: { children: ReactNode; title: string }) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<OffPeakMenuHintSide>("right");

  const updateSide = useCallback(() => {
    // The prompt entry is inside the menu. In a narrow window, Radix will automatically flip right to left.
    // The prompts on the left will pass through the entire menu; when there is insufficient horizontal space, they will be moved to the top of the menu to prevent prompts and operation items from covering each other.
    setSide(
      resolveOffPeakMenuHintSide(
        triggerRef.current?.getBoundingClientRect() ?? null,
        window.innerWidth,
      ),
    );
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    updateSide();
    window.addEventListener("resize", updateSide);
    return () => window.removeEventListener("resize", updateSide);
  }, [open, updateSide]);

  return (
    <ControlHintTooltip
      title={title}
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          updateSide();
        }
        setOpen(nextOpen);
      }}
      triggerRef={triggerRef}
      side={side}
      align={side === "top" ? "end" : "center"}
      sideOffset={OFFPEAK_MENU_HINT_RIGHT_OFFSET}
      className="max-w-[min(20rem,calc(100vw-1rem))]"
    >
      {children}
    </ControlHintTooltip>
  );
}

const STATUS_ICON: Record<OffPeakStatusIconKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  moon: AutomationIdleTimeIcon,
  // The Paused state in the design draft is a circular stop icon, and the old double vertical lines will be misread as a media pause control.
  pause: AutomationPausedIcon,
  spinner: Loader2,
  success: CircleCheck,
  warning: TriangleAlert,
  stopped: AutomationPausedIcon,
};

export function OffPeakTaskList({
  tasks,
  busyOperationId,
  onOpen,
  onPause,
  onContinue,
  onCancel,
  onDelete,
  onOpenSession,
}: OffPeakTaskListProps) {
  const { intl } = useZCodeIntl();
  const sorted = sortOffPeakTasksByCreatedAt(tasks);

  if (sorted.length === 0) {
    return (
      <div className="rounded-[10px] border border-card-border px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "offPeak.list.empty" })}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid auto-rows-[132px] grid-cols-1 gap-x-4 gap-y-4 lg:grid-cols-2",
        // The same caliber as the scheduled task list: up to 8 cards are exposed, and the excess is scrolled by the grid itself to avoid infinite stretching of the page.
        sorted.length > OFFPEAK_LIST_SCROLL_THRESHOLD &&
          "max-h-[1198px] overflow-y-auto overscroll-contain lg:max-h-[606px]",
      )}
    >
      {sorted.map((task) => {
        const footer =
          task.modelSelectionIssue && shouldShowOffPeakModelSelectionIssue(task.status)
            ? {
                icon: "warning" as const,
                className: "text-warning",
                labelId: "offPeak.modelSelection.repairRequired",
              }
            : resolveOffPeakStatusFooter(task);
        const FooterIcon = STATUS_ICON[footer.icon];
        const failedQueueFooter = resolveFailedOffPeakQueueFooter(task);
        const FailedQueueIcon = failedQueueFooter ? STATUS_ICON[failedQueueFooter.icon] : null;
        const busy = busyOperationId?.endsWith(task.offPeakTaskId) ?? false;
        const hasPrimaryMenuAction =
          task.status === "queued" || task.status === "paused" || task.status === "running";
        return (
          <div
            key={task.offPeakTaskId}
            data-testid={TID_OFFPEAK_CARD}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(task)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(task);
              }
            }}
            className={cn(
              // Inset surface shadow is not the card stroke semantics. Under the light and dark theme, there will be a color difference with the homepage card.
              "group relative flex h-full min-h-0 cursor-pointer gap-3 overflow-hidden rounded-[10px] border border-card-border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
              // The completed state remains gray, but the hover background feedback card is still required to be clickable and more menus are operable.
              task.status === "completed" ? "opacity-60 hover:bg-hover" : "hover:bg-hover",
            )}
          >
            <div className="flex h-full min-w-0 flex-1 flex-col gap-3">
              <span className="block truncate pr-14 text-ui-base font-medium leading-5 text-foreground">
                {task.title || task.prompt}
              </span>
              {/* The task card body and status font sizes are scalable; a fixed 18px line height squeezes or clips the text at large font sizes. */}
              <p className="line-clamp-2 h-9 text-ui-base font-normal leading-snug text-foreground-subtle">
                {task.prompt}
              </p>
              <div className="mt-auto flex h-6 min-w-0 items-center gap-[10px] text-ui-base leading-snug">
                {/* Both the status badge and the "Run session: …" on the right are allowed to shrink, and a long
                   session title squeezes the status text down to a single character. The status is
                   the primary information of the footnote, so it becomes shrink-0 and
                   non-shrinking, and only the session title segment truncates.
                   */}
                <div
                  className={cn(
                    "flex w-fit shrink-0 items-center gap-0.5 font-normal",
                    footer.className,
                    (task.status === "queued" || task.status === "paused") &&
                      // The brand of Zai Dark is white, and the queue tag must use the purple semantics specific to the design draft.
                      "rounded-[8px] bg-idle-task-surface py-0.5 pl-1 pr-2 text-idle-task",
                  )}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    <FooterIcon
                      className={cn("size-4 shrink-0", task.status === "running" && "animate-spin")}
                      strokeWidth={1.33}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="truncate">
                    {intl.formatMessage({ id: footer.labelId }, footer.labelValues)}
                  </span>
                </div>
                {failedQueueFooter && FailedQueueIcon ? (
                  <div className="flex w-fit shrink-0 items-center gap-0.5 rounded-[6px] bg-idle-task-surface py-0.5 pl-1 pr-2 text-idle-task opacity-40">
                    <span className="flex size-5 shrink-0 items-center justify-center">
                      <FailedQueueIcon
                        className="size-4 shrink-0"
                        strokeWidth={1.33}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="truncate">
                      {intl.formatMessage(
                        { id: failedQueueFooter.labelId },
                        failedQueueFooter.labelValues,
                      )}
                    </span>
                  </div>
                ) : null}
                {task.sessionTitle ? (
                  // Tasks created within a session are bound to and run within the session in which they were created, and the footer reveals the session title.
                  <span
                    data-testid={TID_OFFPEAK_CARD_SESSION}
                    className="ml-auto min-w-0 truncate text-foreground-subtle"
                    title={task.sessionTitle}
                  >
                    {intl.formatMessage(
                      { id: "offPeak.boundSession.label" },
                      { title: task.sessionTitle },
                    )}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="absolute right-3 top-3 flex items-center gap-1">
              {task.sessionId ? (
                <button
                  type="button"
                  className="flex size-6 items-center justify-center rounded-md opacity-100 transition-colors hover:bg-white/10 md:opacity-0 md:group-hover:opacity-100"
                  aria-label={intl.formatMessage({
                    id: "offPeak.goToSession",
                  })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenSession(task);
                  }}
                >
                  <AutomationExternalLinkIcon
                    className="size-4 text-foreground-subtle"
                    aria-hidden="true"
                  />
                </button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded-md opacity-100 transition-colors hover:bg-white/10 md:opacity-0 md:group-hover:opacity-100 data-[state=open]:bg-white/10 data-[state=open]:opacity-100"
                    data-testid={TID_OFFPEAK_CARD_MENU}
                    aria-label={intl.formatMessage({
                      id: "automations.moreActions",
                    })}
                    disabled={busy}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <AutomationMoreHorizontalIcon
                      className="size-4 text-foreground-subtle"
                      aria-hidden="true"
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={4}
                  className="w-[190px]"
                  onClick={(event) => event.stopPropagation()}
                >
                  {task.status === "queued" ? (
                    <DropdownMenuItem
                      className="gap-1"
                      data-testid={TID_OFFPEAK_ACTION_PAUSE}
                      onSelect={() => onPause(task)}
                    >
                      <span className="flex size-5 items-center justify-center">
                        <AutomationPauseActionIcon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="flex-1">
                        {intl.formatMessage({ id: "offPeak.action.pause" })}
                      </span>
                      {/*
                         Pause has been changed to run immediately, with no second confirmation; the
                         info entry is kept to carry the product hints about queue wait time and
                         re-queueing, so users are not left with no way to learn the consequences of
                         the action.
                         */}
                      <OffPeakMenuHint
                        title={intl.formatMessage({
                          id: "offPeak.action.pauseHint",
                        })}
                      >
                        {/*
                           The hint entry is nested inside a selectable menu item, and a bubbling
                           click would immediately run Pause / Continue; only click is isolated, to
                           avoid pointerdown disturbing Radix's selection timing.
                           */}
                        <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
                          <AutomationInfoIcon
                            className="size-3.5 shrink-0 text-foreground-subtle"
                            aria-hidden="true"
                          />
                        </span>
                      </OffPeakMenuHint>
                    </DropdownMenuItem>
                  ) : null}
                  {task.status === "paused" ? (
                    <DropdownMenuItem
                      className="gap-1"
                      data-testid={TID_OFFPEAK_ACTION_CONTINUE}
                      onSelect={() => onContinue(task)}
                    >
                      <span className="flex size-5 items-center justify-center">
                        <AutomationContinueIcon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="flex-1">
                        {intl.formatMessage({
                          id: "offPeak.action.continue",
                        })}
                      </span>
                      <OffPeakMenuHint
                        title={intl.formatMessage({
                          id: "offPeak.action.continueHint",
                        })}
                      >
                        <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
                          <AutomationInfoIcon
                            className="size-3.5 shrink-0 text-foreground-subtle"
                            aria-hidden="true"
                          />
                        </span>
                      </OffPeakMenuHint>
                    </DropdownMenuItem>
                  ) : null}
                  {task.status === "running" ? (
                    <DropdownMenuItem className="gap-1" onSelect={() => onCancel(task)}>
                      {/* The thin-stroke X is lighter than the neighboring action icons and is inconsistent with the pause-generation semantics in the home page's Chat. */}
                      <span className="flex size-5 items-center justify-center">
                        <AutomationCancelActionIcon
                          className="size-4 fill-current"
                          aria-hidden="true"
                        />
                      </span>
                      {intl.formatMessage({ id: "offPeak.action.cancel" })}
                    </DropdownMenuItem>
                  ) : null}
                  {/* When a terminal-state menu has only the delete item, a fixed divider becomes a top rule with no grouping meaning. */}
                  {hasPrimaryMenuAction ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem
                    className="gap-1 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
                    data-testid={TID_OFFPEAK_ACTION_DELETE}
                    onSelect={() => onDelete(task)}
                  >
                    <AutomationTrashIcon />
                    {intl.formatMessage({ id: "automations.delete" })}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        );
      })}
    </div>
  );
}
