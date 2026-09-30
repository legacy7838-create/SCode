import type { MouseEvent, UIEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { CodingPlanResetType } from "@zcode/shared";
import { CheckIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getContextQuotaMeterGridClass } from "@/chat-input-toolbar/contextQuotaMeterGrid.js";
import { burstCodingPlanQuotaResetConfetti } from "@/lib/codingPlanQuotaResetConfetti.js";

const SUCCESS_DISPLAY_MS = 600;
const ROW_EXIT_MS = 820;

export interface CodingPlanQuotaResetDialogUsageItem {
  color: string;
  id: string;
  label: string;
  percentage: number | null;
  resetTime?: string;
  value: string;
}

export interface CodingPlanQuotaResetDialogResetItem {
  count: number;
  expiresAt: number | null;
  onReset: () => Promise<void>;
  processing?: boolean;
  resetType: CodingPlanResetType;
}

export interface CodingPlanQuotaResetDialogConfig {
  resetItems: CodingPlanQuotaResetDialogResetItem[];
  usageItems: CodingPlanQuotaResetDialogUsageItem[];
}

function getRemainingSeconds(expiresAt: number | null, now: number): number {
  if (expiresAt == null) return 0;
  return Math.max(0, Math.ceil((expiresAt - now) / 1_000));
}

export function formatCodingPlanQuotaResetCountdown(
  totalSeconds: number,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string,
): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const values = {
    days: String(days),
    hours: String(hours),
    minutes: String(minutes),
    seconds: String(seconds),
  };
  if (days > 0) {
    return hours > 0
      ? formatMessage({ id: "codingPlan.quotaReset.countdown.daysHours" }, values)
      : formatMessage({ id: "codingPlan.quotaReset.countdown.daysOnly" }, values);
  }
  if (hours > 0) {
    return minutes > 0
      ? formatMessage({ id: "codingPlan.quotaReset.countdown.hoursMinutes" }, values)
      : formatMessage({ id: "codingPlan.quotaReset.countdown.hoursOnly" }, values);
  }
  return formatMessage({ id: "codingPlan.quotaReset.countdown.minutesSeconds" }, values);
}

function readScrollMasks(viewport: HTMLDivElement) {
  return {
    bottom: viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1,
    top: viewport.scrollTop > 1,
  };
}

function resetTypeLabelId(resetType: CodingPlanResetType) {
  return resetType === "WEEK"
    ? "codingPlan.quotaReset.dialog.week"
    : "codingPlan.quotaReset.dialog.fiveHour";
}

function resetTypeAriaId(resetType: CodingPlanResetType) {
  return resetType === "WEEK"
    ? "codingPlan.quotaReset.resetAriaWeek"
    : "codingPlan.quotaReset.resetAria";
}

interface ResetRowCount {
  /** The number of available sheets given by the server's latest stable reading. */
  authoritative: number;
  /** The number of sheets in this pop-up box that have been successfully written off but have not yet been reflected in the server reading. */
  consumedLocally: number;
}

/** The number of displayed pictures = the number of authoritative pictures - the local has been written off, clamped to 0; when there is no local record, it falls back to the count of config. */
function remainingResetCount(state: ResetRowCount | undefined, fallback: number): number {
  return state ? Math.max(0, state.authoritative - state.consumedLocally) : fallback;
}

function seedResetRowCounts(
  items: CodingPlanQuotaResetDialogResetItem[],
): Map<CodingPlanResetType, ResetRowCount> {
  const seeded = new Map<CodingPlanResetType, ResetRowCount>();
  for (const item of items) {
    seeded.set(item.resetType, { authoritative: item.count, consumedLocally: 0 });
  }
  return seeded;
}

export function CodingPlanQuotaResetDialog({
  config,
  open,
  onOpenChange,
}: {
  config: CodingPlanQuotaResetDialogConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());
  const [resettingType, setResettingType] = useState<CodingPlanResetType | null>(null);
  const [successfulType, setSuccessfulType] = useState<CodingPlanResetType | null>(null);
  const [exitingType, setExitingType] = useState<CodingPlanResetType | null>(null);
  // There may be multiple opportunities of the same type. Maintain {number of authoritative sheets, number of local canceled sheets} by type, and only decrease by 1 after success.
  // Hide the row only when it is reset to zero - avoid hiding the entire row (including remaining opportunities) after one write-off, forcing the user to close and then reopen.
  const [rowCounts, setRowCounts] = useState<Map<CodingPlanResetType, ResetRowCount>>(
    () => new Map(),
  );
  const [scrollMasks, setScrollMasks] = useState({ bottom: false, top: false });
  const resetListRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<number[]>([]);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open !== wasOpenRef.current) {
      // Use a delayed task to close the row for successful feedback; if the user closes and reopens it midway, the old task will contaminate the new pop-up state.
      for (const timer of timersRef.current) window.clearTimeout(timer);
      timersRef.current = [];
    }
    if (open && !wasOpenRef.current) {
      setRowCounts(seedResetRowCounts(config.resetItems));
      setResettingType(null);
      setSuccessfulType(null);
      setExitingType(null);
    }
    wasOpenRef.current = open;
  }, [config.resetItems, open]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    const viewport = resetListRef.current;
    if (viewport) setScrollMasks(readScrollMasks(viewport));
  }, [config.resetItems.length, rowCounts]);

  // Use the server's authoritative reading to reconcile the local number of sheets: an increase in the reading is regarded as a new issuance opportunity, and a decrease in the reading is regarded as the write-off has been reflected
  // And deduct the same amount of local pending confirmations. count===0 (processing/completed transition state) and animation in progress
  // There is no backfilling to avoid taking a snapshot before write-off or completing the placeholder to "resurrection" the row that has just been written off. Types that have been removed from the list (confirmed by server
  // exhaustion) clears local logging to hide the row.
  useEffect(() => {
    if (!open) return;
    setRowCounts((current) => {
      let next: Map<CodingPlanResetType, ResetRowCount> | null = null;
      const ensureNext = () => (next ??= new Map(current));
      const presentTypes = new Set<CodingPlanResetType>();
      for (const item of config.resetItems) {
        presentTypes.add(item.resetType);
        const animating =
          resettingType === item.resetType ||
          successfulType === item.resetType ||
          exitingType === item.resetType;
        const state = current.get(item.resetType);
        if (item.count === 0 || item.processing || animating) {
          if (!state) {
            ensureNext().set(item.resetType, {
              authoritative: item.count,
              consumedLocally: 0,
            });
          }
          continue;
        }
        if (!state) {
          ensureNext().set(item.resetType, { authoritative: item.count, consumedLocally: 0 });
        } else if (item.count > state.authoritative) {
          ensureNext().set(item.resetType, { ...state, authoritative: item.count });
        } else if (item.count < state.authoritative) {
          const drop = state.authoritative - item.count;
          ensureNext().set(item.resetType, {
            authoritative: item.count,
            consumedLocally: Math.max(0, state.consumedLocally - drop),
          });
        }
        // item.count === state.authoritative: The number of pieces the server still stops at before write-off (the reading has not yet caught up),
        // Keep local optimistic values unchanged to prevent newly written-off rows from being resurrected by old readings.
      }
      for (const type of current.keys()) {
        if (!presentTypes.has(type)) {
          ensureNext().delete(type);
        }
      }
      return next ?? current;
    });
  }, [config.resetItems, exitingType, open, resettingType, successfulType]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
    },
    [],
  );

  const visibleResetItems = config.resetItems.filter((item) => {
    const remaining = remainingResetCount(rowCounts.get(item.resetType), item.count);
    return (
      remaining > 0 ||
      resettingType === item.resetType ||
      successfulType === item.resetType ||
      exitingType === item.resetType
    );
  });

  const updateScrollMasks = (event: UIEvent<HTMLDivElement>) => {
    const next = readScrollMasks(event.currentTarget);
    setScrollMasks((current) =>
      current.top === next.top && current.bottom === next.bottom ? current : next,
    );
  };

  const resetLimit = async (
    item: CodingPlanQuotaResetDialogResetItem,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    if (resettingType !== null || item.processing) return;
    const origin = event.currentTarget;
    setResettingType(item.resetType);
    try {
      await item.onReset();
      setSuccessfulType(item.resetType);
      burstCodingPlanQuotaResetConfetti(origin);
      const exitTimer = window.setTimeout(() => setExitingType(item.resetType), SUCCESS_DISPLAY_MS);
      const removeTimer = window.setTimeout(() => {
        // Only add 1 to the number of local canceled sheets of this type (clamp to the authoritative number of sheets) and reset it to zero before hiding it; if there are multiple sheets, the remaining ones will be used.
        // The shape of the number of photos continues to show, no need to close and reopen. After the server reading catches up, the local value will be deducted by the reconciliation effect.
        setRowCounts((current) => {
          const next = new Map(current);
          const state = next.get(item.resetType) ?? {
            authoritative: item.count,
            consumedLocally: 0,
          };
          next.set(item.resetType, {
            ...state,
            consumedLocally: Math.min(state.authoritative, state.consumedLocally + 1),
          });
          return next;
        });
        setResettingType(null);
        setSuccessfulType(null);
        setExitingType(null);
      }, ROW_EXIT_MS);
      timersRef.current.push(exitTimer, removeTimer);
    } catch {
      // The failure reason and toast are handled uniformly by useCodingPlanQuotaResetUi; the pop-up box only returns to the clickable state.
      setResettingType(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="w-[min(480px,calc(100vw-2rem))] max-w-none gap-5"
      >
        <DialogTitle className="min-w-0 truncate pr-8 text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "codingPlan.quotaReset.dialog.title" })}
        </DialogTitle>

        <section aria-label={intl.formatMessage({ id: "codingPlan.quotaReset.dialog.remaining" })}>
          <div
            className={`grid gap-2 ${getContextQuotaMeterGridClass(config.usageItems.length)} max-sm:grid-cols-1`}
          >
            {config.usageItems.map((item) => (
              <div key={item.id} className="min-w-0 rounded-lg bg-surface p-3">
                <div className="truncate text-ui-sm text-foreground-subtle">{item.label}</div>
                <div className="mt-2 flex min-w-0 items-baseline gap-1.5">
                  <span className="text-ui-lg font-semibold leading-none text-foreground">
                    {item.value}
                  </span>
                  {item.resetTime ? (
                    <span className="min-w-0 truncate text-ui-xs text-foreground-subtle">
                      {item.resetTime}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background/50">
                  <div
                    className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
                    style={{
                      backgroundColor: item.color,
                      width: `${Math.max(0, Math.min(100, item.percentage ?? 0))}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>

        {visibleResetItems.length > 0 ? (
          <section
            aria-label={intl.formatMessage({ id: "codingPlan.quotaReset.dialog.resettable" })}
          >
            <div className="relative">
              <div
                ref={resetListRef}
                className="max-h-[262px] overflow-y-auto overscroll-contain pr-1"
                onScroll={updateScrollMasks}
              >
                {visibleResetItems.map((item) => {
                  const success = successfulType === item.resetType;
                  const isExiting = exitingType === item.resetType;
                  const effectiveProcessing = item.processing || resettingType === item.resetType;
                  const remainingSeconds = getRemainingSeconds(item.expiresAt, now);
                  // The same type may hold multiple opportunities, but the server /use does not support specifying which one to write off, and the entry only retains
                  // Number of tickets and earliest expiration time. The remaining value after local reconciliation is calculated from the number of displayed sheets: after writing off one sheet, the bank will use the remaining value
                  // The number of pictures continues to be displayed. When there are multiple sheets, explicitly mark the number of sheets and "fastest" to prevent users from misreading the earliest expiry time.
                  // Uniform deadline for all opportunities.
                  const remaining = remainingResetCount(rowCounts.get(item.resetType), item.count);
                  const hasMultipleOpportunities = remaining > 1;
                  return (
                    <div
                      key={item.resetType}
                      className={`grid min-w-0 transition-[grid-template-rows,opacity] duration-200 ease-out last:[&>div]:pb-0 motion-reduce:transition-none ${
                        isExiting
                          ? "pointer-events-none grid-rows-[0fr] opacity-0"
                          : "grid-rows-[1fr] opacity-100"
                      }`}
                    >
                      <div className="min-h-0 overflow-hidden pb-2">
                        <div className="flex min-w-0 items-center gap-3 rounded-lg bg-surface p-3 transition-colors hover:bg-surface-hover">
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-ui-base text-foreground">
                                {intl.formatMessage({ id: resetTypeLabelId(item.resetType) })}
                              </span>
                              {hasMultipleOpportunities ? (
                                <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-interaction-confirmation-surface px-1.5 text-ui-sm text-interaction-confirmation-foreground">
                                  {intl.formatMessage(
                                    { id: "codingPlan.quotaReset.dialog.itemCount" },
                                    { count: remaining },
                                  )}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle tabular-nums">
                              {intl.formatMessage(
                                {
                                  id: hasMultipleOpportunities
                                    ? "codingPlan.quotaReset.dialog.expiresInSoonest"
                                    : "codingPlan.quotaReset.dialog.expiresIn",
                                },
                                {
                                  time: formatCodingPlanQuotaResetCountdown(
                                    remainingSeconds,
                                    intl.formatMessage,
                                  ),
                                },
                              )}
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="default"
                            size="sm"
                            aria-label={
                              success
                                ? intl.formatMessage({ id: "codingPlan.quotaReset.success" })
                                : intl.formatMessage({ id: resetTypeAriaId(item.resetType) })
                            }
                            className="bg-success text-success-foreground hover:bg-success/80"
                            disabled={Boolean(
                              success ||
                              effectiveProcessing ||
                              (resettingType !== null && resettingType !== item.resetType),
                            )}
                            onClick={(event) => void resetLimit(item, event)}
                          >
                            {success ? (
                              <>
                                <CheckIcon className="size-3.5" aria-hidden="true" />
                                {intl.formatMessage({ id: "codingPlan.quotaReset.completed" })}
                              </>
                            ) : effectiveProcessing ? (
                              <Loader2
                                className="size-3.5 animate-spin motion-reduce:animate-none"
                                aria-hidden="true"
                              />
                            ) : (
                              intl.formatMessage({ id: "codingPlan.quotaReset.reset" })
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-popover to-transparent transition-opacity duration-150 ${
                  scrollMasks.top ? "opacity-100" : "opacity-0"
                }`}
              />
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-popover to-transparent transition-opacity duration-150 ${
                  scrollMasks.bottom ? "opacity-100" : "opacity-0"
                }`}
              />
            </div>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
