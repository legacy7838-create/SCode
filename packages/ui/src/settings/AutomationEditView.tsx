/* eslint-disable max-lines -- the whole scheduled-task edit page centrally maintains the
 * Settings/History tabs, the cron builder, the project/model selectors, and the run history;
 * keeping it together is better for interaction consistency.
 */
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { completeNewModelSelection } from "@zcode/provider";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  MessageCircle,
  X,
} from "lucide-react";
import {
  resolveWorkspaceKey,
  testId,
  TID_AUTOMATION_CUSTOM_CONFIRM,
  TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT,
  TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT,
  TID_AUTOMATION_CUSTOM_INTERVAL_SELECT,
  TID_AUTOMATION_CUSTOM_REPEAT_EDIT,
  TID_AUTOMATION_CUSTOM_UNIT_OPTION,
  TID_AUTOMATION_CUSTOM_UNIT_SELECT,
  TID_AUTOMATION_FORM_PROMPT,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_AUTOMATION_FREQUENCY_SELECT,
  TID_AUTOMATION_RUN_NOW,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATION_SCHEDULE_DELETE,
  TID_AUTOMATION_SCHEDULE_PREVIEW,
  TID_AUTOMATION_YEAR_DAY_OPTION,
  TID_AUTOMATION_YEAR_MONTH_OPTION,
  TID_AUTOMATION_YEAR_MONTHDAY,
  ZCODE_AGENT_PROVIDER,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationScheduleRule,
} from "@zcode/shared";
import {
  AutomationAddScheduleIcon,
  AutomationChevronDownIcon,
  AutomationContinueIcon,
  AutomationExternalLinkIcon,
  AUTOMATION_FORM_FIELD_CLASSNAME,
  AutomationHistoryEmptyState,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationRunNowIcon,
  AutomationSettingsHistoryTabs,
  AutomationTrashIcon,
  type AutomationSettingsHistoryTab,
} from "@/settings/AutomationDesignPrimitives.js";
import {
  AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,
  AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
  AutomationInstructionsComposer,
  AutomationInstructionsTextarea,
  AutomationInstructionsToolbar,
} from "@/settings/AutomationInstructionsComposer.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Spinner } from "@/components/ui/spinner.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { cn } from "@/components/lib/utils.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { resolveLocalizedAutomationCreateTitle } from "@/settings/automationEditLocalizedTitle.js";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { ConfigSelect } from "@/chat-input-toolbar/display.js";
import { ChatEmptyWorkspacePreviewMenu, type ChatEmptyWorkspaceMenuTab } from "@/ChatEmptyState.js";
import {
  AUTOMATION_DEFAULT_MODE,
  buildAutomationModelSelectGroups,
  buildAutomationModeOption,
  buildAutomationThoughtLevelOption,
  resolveAutomationModelItem,
  resolveAutomationModelTriggerLabel,
  resolveAutomationPreferredModelValue,
} from "@/settings/automationAgentConfigOptions.js";
import {
  resolveChangedAutomationEditFields,
  type AutomationEditDirtyField,
  type AutomationEditFieldSignatures,
} from "@/settings/automationEditDirtyState.js";
import {
  clearAutomationEditRequiredFieldError,
  resolveAutomationEditRequiredFieldErrors,
  type AutomationEditRequiredField,
} from "@/settings/automationEditValidation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useAutomationProjectOptions } from "@/hooks/useAutomationProjectOptions.js";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { startUserAction } from "@/lib/userActionTelemetry.js";
import { logger } from "@/logger.js";
import {
  findAutomationWorkspaceOptionByKey,
  reconcileAutomationWorkspaceSelectionKey,
  resolveAutomationWorkspaceSelectionKey,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";
import {
  buildCronExpr,
  canVisualizeCronInAutomationEditor,
  describeCronBuilder,
  formatDateTime,
  formatDuration,
  formatGmtOffset,
  isSessionCreatedAutomation as resolveIsSessionCreatedAutomation,
  parseCronToBuilder,
  resolveAutomationStatusKind,
  WEEKDAY_ORDER,
  type AutomationStatusKind,
  type CronBuilderState,
  type CronFrequency,
  type CustomRepeatUnit,
} from "@/settings/automationFormat.js";
import type {
  AutomationRunsEntry,
  CreateAutomationInput,
  UpdateAutomationInput,
} from "@/store/automationManagementStore.js";

const MODEL_ITEM_NEVER_LOCKED = () => false;
const FREQUENCIES: CronFrequency[] = ["hourly", "daily", "weekdays", "weekly", "monthly", "custom"];
const isCronFrequency = (value: string): value is CronFrequency =>
  FREQUENCIES.includes(value as CronFrequency);
/** Number of run-history entries per page. */
const RUNS_PAGE_SIZE = 8;
/** The visual range in which the custom recurrence input accepts input. */
const CUSTOM_REPEAT_INTERVAL_INPUT_MIN = 0;
/** A cron step must be a positive integer; 0 cannot form a valid schedule. */
const CUSTOM_REPEAT_INTERVAL_SCHEDULABLE_MIN = 1;
const CUSTOM_REPEAT_INTERVAL_MAX = 200;

/**
 * Builds the page number sequence for the pagination control: 3 pages at each end, 1 page on either
 * side of the current page, and everything else collapsed into an ellipsis. Example:
 * current=1,total=10 → [1,2,3,"ellipsis",8,9,10].
 */
function buildRunsPageItems(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const pages = new Set<number>([
    1,
    2,
    3,
    total - 2,
    total - 1,
    total,
    current - 1,
    current,
    current + 1,
  ]);
  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const items: Array<number | "ellipsis"> = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) {
      items.push("ellipsis");
    }
    items.push(page);
    previous = page;
  }
  return items;
}

function workspaceLabelFromPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

const CUSTOM_REPEAT_SELECT_CONTENT_CLASS =
  "w-[var(--radix-select-trigger-width)] px-0 py-1.5 [&_[data-position=popper]]:px-1 [&_[data-slot=select-scroll-up-button]]:hidden [&_[data-slot=select-scroll-down-button]]:hidden";
const CUSTOM_REPEAT_SELECT_ITEM_CLASS =
  "min-h-8 rounded-[8px] px-2 py-1.5 pr-8 text-ui-base leading-5 text-foreground-subtle data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-[state=checked]:bg-menu-hover data-[state=checked]:text-foreground";

function CustomRepeatSelectIndicator() {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
      <ChevronDown className="size-4" strokeWidth={2} />
    </span>
  );
}

function CustomRepeatCalendarIcon({ className }: { className?: string }) {
  return <CalendarDays className={className} strokeWidth={2} />;
}

/**
 * A single-column scrolling list for time selection (hours or minutes); the selected item
 * auto-scrolls into view when the list opens. Time options are everyday interaction controls and
 * should not reuse the smallest font-size token meant only for badges and compact labels. The
 * selected time is a menu selection state, not a primary action button, so menu hover semantics are
 * used to avoid an abrupt black block in the Light theme.
 */
function TimeUnitColumn({
  count,
  selected,
  onSelect,
}: {
  count: number;
  selected: number;
  onSelect: (value: number) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center" });
  }, []);
  return (
    <ScrollArea className="h-52 w-14 shrink-0">
      <div className="flex flex-col gap-0.5 p-1">
        {Array.from({ length: count }, (_, value) => value).map((value) => (
          <button
            key={value}
            ref={value === selected ? selectedRef : undefined}
            type="button"
            onClick={() => onSelect(value)}
            className={cn(
              "rounded-md px-2 py-1 text-center text-ui-base tabular-nums transition-colors",
              value === selected
                ? "bg-menu-hover text-foreground"
                : "text-foreground-subtle hover:bg-menu-hover hover:text-foreground",
            )}
          >
            {pad2(value)}
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}

/**
 * HH:MM time picker: a pill trigger plus hour/minute scrolling columns inside the popover. The
 * time-pick trigger is an everyday interaction control and should use the body base font size
 * text-ui-base.
 */
function TimeOfDayPicker({
  hour,
  minute,
  onChange,
  ariaLabel,
}: {
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className="inline-flex h-auto items-center gap-1 rounded-full bg-hover py-px pl-2 pr-1.5 text-ui-base leading-5 tabular-nums text-foreground transition-colors hover:bg-selected focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          {pad2(hour)}:{pad2(minute)}
          <span className="shrink-0 text-foreground-subtle">
            <AutomationChevronDownIcon />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-29 flex-row gap-0 p-0"
      >
        <TimeUnitColumn count={24} selected={hour} onSelect={(value) => onChange(value, minute)} />
        <div className="w-px shrink-0 bg-border" />
        <TimeUnitColumn count={60} selected={minute} onSelect={(value) => onChange(hour, value)} />
      </PopoverContent>
    </Popover>
  );
}

/** Single-column scrolling list for month/day (1-based values), styled to match TimeUnitColumn. */
function ScrollNumberColumn({
  values,
  selected,
  onSelect,
  buttonTestIdPrefix,
}: {
  values: number[];
  selected: number;
  onSelect: (value: number) => void;
  /** When provided, each digit button carries a `${prefix}-${value}` data-testid (for e2e). */
  buttonTestIdPrefix?: string;
}) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center" });
  }, []);
  return (
    <ScrollArea className="h-52 w-14 shrink-0">
      <div className="flex flex-col gap-0.5 p-1">
        {values.map((value) => (
          <button
            key={value}
            ref={value === selected ? selectedRef : undefined}
            type="button"
            data-testid={buttonTestIdPrefix ? testId(buttonTestIdPrefix, String(value)) : undefined}
            onClick={() => onSelect(value)}
            className={cn(
              "rounded-md px-2 py-1 text-center text-ui-sm tabular-nums transition-colors",
              value === selected
                ? "bg-primary text-primary-foreground"
                : "text-foreground-subtle hover:bg-surface-hover",
            )}
          >
            {pad2(value)}
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}

/**
 * Number of days in a month (leap year 2024 is used as the reference, so February goes up to 29);
 * month is 1-12.
 */
function daysInMonth(month: number): number {
  return new Date(2024, month, 0).getDate();
}

/**
 * Month/day picker (used for custom → yearly): a pill trigger plus month/day scrolling columns
 * inside the popover, styled to match TimeOfDayPicker. After switching months, a selected day that
 * exceeds that month's maximum day converges automatically.
 */
function MonthDayPicker({
  month,
  day,
  intl,
  onChange,
}: {
  month: number;
  day: number;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onChange: (month: number, day: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const months = Array.from({ length: 12 }, (_, index) => index + 1);
  const days = Array.from({ length: daysInMonth(month) }, (_, index) => index + 1);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={TID_AUTOMATION_YEAR_MONTHDAY}
          aria-label={intl.formatMessage({
            id: "automations.form.schedule.yearDateLabel",
          })}
          className="inline-flex h-auto items-center gap-1 rounded-full bg-hover py-px pl-2 pr-1.5 text-ui-base leading-5 tabular-nums text-foreground transition-colors hover:bg-selected focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          {intl.formatMessage(
            { id: "automations.form.schedule.monthDayValue" },
            { month: String(month), day: String(day) },
          )}
          <span className="shrink-0 text-foreground-subtle">
            <AutomationChevronDownIcon />
          </span>
        </button>
      </PopoverTrigger>
      {/* Consistent with TimeOfDayPicker: flex-row overrides PopoverContent's default flex-col so the month/day columns sit side by side. */}
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-29 flex-row gap-0 p-0"
      >
        <ScrollNumberColumn
          values={months}
          selected={month}
          buttonTestIdPrefix={TID_AUTOMATION_YEAR_MONTH_OPTION}
          onSelect={(value) => onChange(value, Math.min(day, daysInMonth(value)))}
        />
        <div className="w-px shrink-0 bg-border" />
        <ScrollNumberColumn
          values={days}
          selected={day}
          buttonTestIdPrefix={TID_AUTOMATION_YEAR_DAY_OPTION}
          onSelect={(value) => onChange(month, value)}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Day-of-week selection: keeps the sentence-style trigger and forbids clearing the last day. */
function WeekdayPicker({
  weekdays,
  intl,
  onChange,
}: {
  weekdays: number[];
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onChange: (weekdays: number[]) => void;
}) {
  const label = WEEKDAY_ORDER.filter((day) => weekdays.includes(day))
    .map((day) => intl.formatMessage({ id: `automations.weekday.${day}` }))
    .join(intl.formatMessage({ id: "automations.weekday.separator" }));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={intl.formatMessage({
            id: "automations.form.schedule.weekdaysLabel",
          })}
          // The multi-select trigger of the week uses the same highlight as the frequency and time tag of the same layer to avoid brightness inconsistency.
          className="inline-flex h-auto max-w-full items-center gap-0.5 rounded-full bg-hover py-px pl-2 pr-0.5 text-ui-base leading-5 text-foreground transition-colors hover:bg-selected data-[state=open]:bg-selected focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          <span className="truncate">{label}</span>
          <AutomationChevronDownIcon />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-40 p-1">
        {WEEKDAY_ORDER.map((day) => {
          const active = weekdays.includes(day);
          return (
            <button
              key={day}
              type="button"
              onClick={() => {
                if (active && weekdays.length === 1) return;
                onChange(
                  active ? weekdays.filter((candidate) => candidate !== day) : [...weekdays, day],
                );
              }}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-ui-base text-foreground transition-colors hover:bg-menu-hover"
            >
              {/* Putting the check slot at the start of the row would pull the weekday menu away from the standard trailing-status layout. */}
              <span className="min-w-0 flex-1 truncate">
                {intl.formatMessage({ id: `automations.weekday.${day}` })}
              </span>
              <span className="flex size-4 shrink-0 items-center justify-center">
                {active ? <Check className="size-3.5" aria-hidden="true" /> : null}
              </span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

function toDateInputValue(timestamp: number | undefined): string {
  const date = timestamp ? new Date(timestamp) : new Date(Date.now() + 24 * 60 * 60 * 1_000);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function localDateEndTimestamp(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

function parseDateInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function EndDatePicker({
  disabled,
  intl,
  min,
  onChange,
  value,
}: {
  disabled: boolean;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  min: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const selectedDate = parseDateInputValue(value);
  const minDate = parseDateInputValue(min);
  const [visibleMonth, setVisibleMonth] = useState(() => selectedDate ?? minDate ?? new Date());

  useEffect(() => {
    if (open && selectedDate) setVisibleMonth(selectedDate);
  }, [open, selectedDate?.getTime()]);

  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayValue = toDateInputValue(Date.now());
  const monthLabel = intl.formatMessage(
    { id: "automations.customRepeat.monthLabel" },
    { year: String(year), month: String(month + 1) },
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex h-9 w-[135px] items-center justify-center gap-1.5 rounded-lg border border-input-border bg-input pl-3 pr-3.5 text-ui-base font-normal leading-5 tracking-[-0.18px] text-foreground transition-colors hover:border-input-border-hover hover:bg-input/80 data-[state=open]:border-input-border-hover data-[state=open]:bg-input/80 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-input-border disabled:hover:bg-input"
        >
          <CustomRepeatCalendarIcon className="size-5 shrink-0 text-foreground-subtle" />
          <span className="tabular-nums">
            {selectedDate
              ? `${selectedDate.getFullYear()}/${pad2(selectedDate.getMonth() + 1)}/${pad2(selectedDate.getDate())}`
              : value}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-72 p-3">
        <div className="mb-3 flex h-8 items-center justify-between">
          <span className="text-ui-sm font-medium text-foreground">{monthLabel}</span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setVisibleMonth(new Date(year, month - 1, 1))}
              aria-label={intl.formatMessage({
                id: "automations.customRepeat.previousMonth",
              })}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setVisibleMonth(new Date(year, month + 1, 1))}
              aria-label={intl.formatMessage({
                id: "automations.customRepeat.nextMonth",
              })}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {[0, 1, 2, 3, 4, 5, 6].map((day) => (
            <span
              key={day}
              className="flex size-8 items-center justify-center text-ui-sm text-foreground-subtlest"
            >
              {intl.formatMessage({ id: `automations.weekday.${day}` })}
            </span>
          ))}
          {Array.from({ length: firstWeekday }, (_, index) => (
            <span key={`blank-${index}`} className="size-8" />
          ))}
          {Array.from({ length: daysInMonth }, (_, index) => index + 1).map((day) => {
            const dateValue = `${year}-${pad2(month + 1)}-${pad2(day)}`;
            const selected = dateValue === value;
            const isToday = dateValue === todayValue;
            const unavailable = dateValue < min;
            return (
              <button
                key={day}
                type="button"
                disabled={unavailable}
                onClick={() => {
                  onChange(dateValue);
                  setOpen(false);
                }}
                className={cn(
                  "flex size-8 items-center justify-center rounded-[8px] text-ui-base tabular-nums transition-colors",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground hover:bg-menu-hover",
                  isToday && !selected && "ring-1 ring-inset ring-border-hover",
                  unavailable && "cursor-not-allowed text-foreground-subtlest opacity-35",
                )}
              >
                {day}
              </button>
            );
          })}
          {Array.from({ length: 42 - firstWeekday - daysInMonth }, (_, index) => (
            <span key={`trailing-blank-${index}`} className="size-8" />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CustomRepeatDialog({
  builder,
  endAt,
  intl,
  onConfirm,
  onOpenChange,
  open,
}: {
  builder: CronBuilderState;
  endAt: number | undefined;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onConfirm: (value: {
    interval: number;
    unit: CustomRepeatUnit;
    weekdays: number[];
    monthDays: number[];
    monthlyMode: CronBuilderState["customMonthlyMode"];
    endAt?: number;
  }) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [intervalInput, setIntervalInput] = useState(String(builder.customInterval));
  const [unit, setUnit] = useState<CustomRepeatUnit>(builder.customUnit);
  const [weekdays, setWeekdays] = useState(builder.customWeekdays);
  const [monthDays, setMonthDays] = useState(builder.customMonthDays);
  const [monthlyMode, setMonthlyMode] = useState(builder.customMonthlyMode);
  const [ends, setEnds] = useState(endAt !== undefined);
  const [endDate, setEndDate] = useState(toDateInputValue(endAt));

  useEffect(() => {
    if (!open) return;
    setIntervalInput(String(builder.customInterval));
    setUnit(builder.customUnit);
    setWeekdays(builder.customWeekdays);
    setMonthDays(builder.customMonthDays);
    setMonthlyMode(builder.customMonthlyMode);
    setEnds(endAt !== undefined);
    setEndDate(toDateInputValue(endAt));
  }, [builder, endAt, open]);

  const interval = Number(intervalInput);
  const isIntervalValid =
    /^\d+$/.test(intervalInput) &&
    Number.isInteger(interval) &&
    interval >= CUSTOM_REPEAT_INTERVAL_SCHEDULABLE_MIN &&
    interval <= CUSTOM_REPEAT_INTERVAL_MAX;
  const canIncrementInterval = intervalInput === "" || interval < CUSTOM_REPEAT_INTERVAL_MAX;
  const canDecrementInterval = intervalInput !== "" && interval > CUSTOM_REPEAT_INTERVAL_INPUT_MIN;
  const stepInterval = (delta: 1 | -1) => {
    const currentInterval = /^\d+$/.test(intervalInput)
      ? interval
      : CUSTOM_REPEAT_INTERVAL_INPUT_MIN;
    const nextInterval = Math.min(
      CUSTOM_REPEAT_INTERVAL_MAX,
      Math.max(CUSTOM_REPEAT_INTERVAL_INPUT_MIN, currentInterval + delta),
    );
    setIntervalInput(String(nextInterval));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] w-[400px] gap-0 overflow-y-auto border-border bg-card p-0 shadow-[0_20px_25px_-5px_rgba(0,0,0,0.1),0_8px_10px_-6px_rgba(0,0,0,0.1)]"
        aria-describedby={undefined}
        showCloseButton={false}
      >
        <DialogHeader className="px-5 pb-5 pt-5">
          <DialogTitle className="text-ui-xl font-medium leading-[26px] tracking-[-0.12px]">
            {intl.formatMessage({ id: "automations.customRepeat.title" })}
          </DialogTitle>
          <DialogClose asChild>
            <button
              type="button"
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute right-5 top-5 flex size-6 items-center justify-center rounded-[6px] opacity-80 transition-colors hover:bg-surface-hover hover:opacity-100"
            >
              <X className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
          </DialogClose>
        </DialogHeader>

        <div className="space-y-5 px-5">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="automation-custom-interval"
              className="text-ui-base leading-5 tracking-[-0.18px] text-foreground"
            >
              {intl.formatMessage({ id: "automations.customRepeat.frequency" })}
            </label>
            <div className="grid grid-cols-2 gap-4">
              <div className="relative">
                <Input
                  id="automation-custom-interval"
                  type="number"
                  min={CUSTOM_REPEAT_INTERVAL_INPUT_MIN}
                  max={CUSTOM_REPEAT_INTERVAL_MAX}
                  step={1}
                  inputMode="numeric"
                  value={intervalInput}
                  aria-invalid={!isIntervalValid}
                  className="h-9 rounded-lg px-3 pr-10 text-mobile-input-safe leading-6 tracking-[-0.18px] [appearance:textfield] md:text-ui-base md:leading-5 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_SELECT}
                  onChange={(event) => {
                    const value = event.target.value;
                    // The number input allows null values and scientific notation; retain null values for ease of editing,
                    // But only accepts non-negative integer literals to avoid writing invalid values into cron/scheduleRule.
                    if (value === "" || /^\d+$/.test(value)) setIntervalInput(value);
                  }}
                />
                {/* The native number spinner differs in size and themed feedback between system browsers and
                    WebViews; controlled stepper buttons are used instead to unify the tap styling
                    of desktop and mobile web.
                    */}
                <div className="absolute inset-y-px right-px flex w-8 flex-col overflow-hidden rounded-r-[7px] border-l border-input-border bg-input">
                  <button
                    type="button"
                    aria-label="+1"
                    title="+1"
                    data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT}
                    disabled={!canIncrementInterval}
                    onClick={() => stepInterval(1)}
                    className="flex flex-1 items-center justify-center border-b border-input-border text-foreground-subtle transition-colors hover:bg-input-focused hover:text-foreground focus-visible:z-10 focus-visible:bg-input-focused focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronUp className="size-3" strokeWidth={2} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label="-1"
                    title="-1"
                    data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT}
                    disabled={!canDecrementInterval}
                    onClick={() => stepInterval(-1)}
                    className="flex flex-1 items-center justify-center text-foreground-subtle transition-colors hover:bg-input-focused hover:text-foreground focus-visible:z-10 focus-visible:bg-input-focused focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronDown className="size-3" strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <Select
                value={unit}
                onValueChange={(value) => {
                  const nextUnit = value as CustomRepeatUnit;
                  setUnit(nextUnit);
                  if (nextUnit === "yearly") setMonthDays([new Date().getDate()]);
                }}
              >
                <SelectTrigger
                  className="h-9 w-full rounded-[8px] px-3 text-ui-base leading-5 tracking-[-0.18px] hover:bg-input/80 data-[state=open]:border-input-border-hover data-[state=open]:bg-input/80"
                  data-testid={TID_AUTOMATION_CUSTOM_UNIT_SELECT}
                  indicator={<CustomRepeatSelectIndicator />}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  align="start"
                  side="bottom"
                  sideOffset={4}
                  collisionPadding={8}
                  className={CUSTOM_REPEAT_SELECT_CONTENT_CLASS}
                >
                  <SelectItem
                    value="minute"
                    className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "minute")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.minute",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="hourly"
                    className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "hourly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.hour",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="daily"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "daily")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.day",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="weekly"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "weekly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.week",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="monthly"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "monthly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.month",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="yearly"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "yearly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.year",
                    })}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {unit === "weekly" ? (
            <div className="grid grid-cols-7 gap-2">
              {WEEKDAY_ORDER.map((day) => {
                const active = weekdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => {
                      if (active && weekdays.length === 1) return;
                      setWeekdays(
                        active
                          ? weekdays.filter((candidate) => candidate !== day)
                          : [...weekdays, day],
                      );
                    }}
                    className={cn(
                      "flex h-9 items-center justify-center rounded-md border text-ui-base",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-surface-hover",
                    )}
                  >
                    {intl.formatMessage({ id: `automations.weekday.${day}` })}
                  </button>
                );
              })}
            </div>
          ) : null}

          {unit === "monthly" ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ui-base text-foreground">
                  {intl.formatMessage({ id: "automations.customRepeat.rule" })}
                </span>
                <Select
                  value={monthlyMode}
                  onValueChange={(value) =>
                    setMonthlyMode(value as CronBuilderState["customMonthlyMode"])
                  }
                >
                  <SelectTrigger
                    className="h-9 w-32 rounded-[8px] px-3 text-ui-base hover:bg-input/80 data-[state=open]:border-input-border-hover data-[state=open]:bg-input/80"
                    indicator={<CustomRepeatSelectIndicator />}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    align="start"
                    side="bottom"
                    sideOffset={4}
                    collisionPadding={8}
                    className={CUSTOM_REPEAT_SELECT_CONTENT_CLASS}
                  >
                    <SelectItem value="date" className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}>
                      {intl.formatMessage({
                        id: "automations.customRepeat.byDate",
                      })}
                    </SelectItem>
                    <SelectItem value="weekday" className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}>
                      {intl.formatMessage({
                        id: "automations.customRepeat.byWeekday",
                      })}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {monthlyMode === "date" ? (
                <div className="grid grid-cols-10 gap-2.5">
                  {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => {
                    const active = monthDays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => {
                          if (active && monthDays.length === 1) return;
                          setMonthDays(
                            active
                              ? monthDays.filter((candidate) => candidate !== day)
                              : [...monthDays, day],
                          );
                        }}
                        className={cn(
                          "flex h-7 w-full items-center justify-center rounded-[8px] border text-ui-sm",
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border hover:bg-surface-hover",
                        )}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="grid grid-cols-7 gap-2">
                  {WEEKDAY_ORDER.map((day) => {
                    const active = weekdays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => setWeekdays([day])}
                        className={cn(
                          "flex h-9 items-center justify-center rounded-md border text-ui-base",
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border hover:bg-surface-hover",
                        )}
                      >
                        {intl.formatMessage({
                          id: `automations.weekday.${day}`,
                        })}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <span className="text-ui-base leading-5 tracking-[-0.18px] text-foreground">
              {intl.formatMessage({ id: "automations.customRepeat.ends" })}
            </span>
            <div className="flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => setEnds(false)}
                className="flex h-9 items-center gap-2 rounded-[8px] px-2 text-ui-base leading-5 tracking-[-0.18px] transition-colors hover:bg-surface-hover"
              >
                <span className="flex size-5 items-center justify-center">
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full border-[1.33px]",
                      !ends ? "border-[#4099FF] bg-[#4099FF]" : "border-border",
                    )}
                  >
                    {!ends ? <span className="size-1.5 rounded-full bg-white" /> : null}
                  </span>
                </span>
                {intl.formatMessage({
                  id: "automations.customRepeat.neverEnds",
                })}
              </button>
              <button
                type="button"
                onClick={() => setEnds(true)}
                className="flex h-9 items-center gap-2 rounded-[8px] px-2 text-ui-base leading-5 tracking-[-0.18px] transition-colors hover:bg-surface-hover"
              >
                <span className="flex size-5 items-center justify-center">
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full border-[1.33px]",
                      ends ? "border-[#4099FF] bg-[#4099FF]" : "border-border",
                    )}
                  >
                    {ends ? <span className="size-1.5 rounded-full bg-white" /> : null}
                  </span>
                </span>
                {intl.formatMessage({
                  id: "automations.customRepeat.endsOption",
                })}
              </button>
            </div>
            {/* A native date input pops up an uncontrollable system-white month calendar in dark themes. */}
            <EndDatePicker
              value={endDate}
              min={toDateInputValue(Date.now())}
              disabled={!ends}
              intl={intl}
              onChange={setEndDate}
            />
          </div>
        </div>

        <DialogFooter className="gap-3 px-5 pb-5 pt-5">
          <DialogClose asChild>
            <Button
              type="button"
              variant="outline"
              className="h-9 rounded-[8px] px-4 text-ui-base font-medium leading-5 tracking-[-0.18px] hover:border-border-hover hover:bg-input/50"
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
          </DialogClose>
          <Button
            type="button"
            className="h-9 rounded-[8px] px-4 text-ui-base font-medium leading-5 tracking-[-0.18px] hover:bg-primary/80"
            data-testid={TID_AUTOMATION_CUSTOM_CONFIRM}
            disabled={!isIntervalValid || (ends && !localDateEndTimestamp(endDate))}
            onClick={() => {
              onConfirm({
                interval,
                unit,
                weekdays,
                monthDays,
                monthlyMode,
                ...(ends ? { endAt: localDateEndTimestamp(endDate) } : {}),
              });
              onOpenChange(false);
            }}
          >
            {intl.formatMessage({ id: "common.confirm" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface AutomationEditSubmit {
  input: CreateAutomationInput | UpdateAutomationInput;
  /** Target project (may differ from the current list's project when creating). */
  workspacePath: string;
  workspaceIdentity?: string;
}

interface AutomationEditViewProps {
  /** null = creating; otherwise editing. */
  editing: ZCodeAutomation | null;
  /** Prefilled when creating (from the More ideas template). */
  initialDraft?: { title: string; cronExpr: string; prompt: string } | null;
  /** The project the current list belongs to, used as the default target project when creating. */
  defaultWorkspacePath: string;
  defaultWorkspaceIdentity?: string;
  onManageModels?: () => void;
  saving: boolean;
  onSubmit: (params: AutomationEditSubmit) => Promise<boolean>;
  onBack: () => void;
  /** Editing state: run now / enable-disable / delete. */
  onRunNow?: (automation: ZCodeAutomation) => Promise<void> | void;
  onToggle?: (automation: ZCodeAutomation, enabled: boolean) => void;
  onDelete?: (automation: ZCodeAutomation) => void;
  /** Run history in the History tab. */
  runsEntry?: AutomationRunsEntry;
  onLoadRuns?: () => void;
  onDeleteRun?: (runId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}

async function saveAndRunAutomation(
  save: () => Promise<boolean>,
  run: () => Promise<void> | void,
): Promise<boolean> {
  if (!(await save())) return false;
  await run();
  return true;
}

function defaultBuilder(): CronBuilderState {
  return {
    frequency: "daily",
    hour: 9,
    minute: 0,
    weekdays: [1],
    dayOfMonth: 1,
    rawExpr: "0 9 * * *",
    customInterval: 1,
    customUnit: "daily",
    customWeekdays: [1],
    customMonthDays: [1],
    customMonth: new Date().getMonth() + 1,
    customMonthlyMode: "date",
  };
}

function initialBuilder(
  editing: ZCodeAutomation | null,
  initialDraft?: { title: string; cronExpr: string; prompt: string } | null,
): CronBuilderState {
  if (!editing) {
    return initialDraft ? parseCronToBuilder(initialDraft.cronExpr) : defaultBuilder();
  }

  const parsedBuilder = parseCronToBuilder(editing.cronExpr);
  if (!editing.scheduleRule) return parsedBuilder;

  return {
    ...parsedBuilder,
    frequency: "custom",
    hour: editing.scheduleRule.hour,
    minute: editing.scheduleRule.minute,
    customInterval: editing.scheduleRule.interval,
    customUnit: editing.scheduleRule.unit,
    customWeekdays: editing.scheduleRule.weekdays ?? [1],
    customMonthDays: editing.scheduleRule.monthDays ?? [1],
    customMonth:
      editing.scheduleRule.months?.[0] ?? new Date(editing.scheduleRule.anchorAt).getMonth() + 1,
    customMonthlyMode: editing.scheduleRule.monthlyMode ?? "date",
  };
}

// ---- Running history status mapping (consistent with AutomationRunsDialog) ----
type RunStatusKind = "running" | "succeeded" | "failed" | "stopped" | "skipped";
function resolveRunStatus(run: ZCodeAutomationRun): RunStatusKind {
  if (run.dispatchStatus === "skipped") return "skipped";
  if (run.dispatchStatus === "failed_to_dispatch") return "failed";
  switch (run.outcome) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return "running";
  }
}
// The running status is presented as "dots + colored text" (Scheduled history table density specification).
const RUN_STATUS_DOT_CLASS: Record<RunStatusKind, string> = {
  running: "bg-primary",
  succeeded: "bg-success",
  failed: "bg-destructive",
  stopped: "bg-foreground-subtlest",
  skipped: "bg-warning",
};
const RUN_STATUS_TEXT_CLASS: Record<RunStatusKind, string> = {
  running: "text-primary",
  succeeded: "text-success",
  failed: "text-destructive",
  stopped: "text-foreground-subtle",
  skipped: "text-warning",
};

const AUTOMATION_STATUS_DOT_CLASS: Record<AutomationStatusKind, string> = {
  active: "bg-success",
  paused: "bg-warning",
  failed: "bg-destructive",
  completed: "bg-foreground-subtlest",
};

function normalizeAutomationScheduleRule(
  rule: ZCodeAutomationScheduleRule | null | undefined,
): Record<string, unknown> | null {
  if (!rule) return null;
  return {
    unit: rule.unit,
    interval: rule.interval,
    hour: rule.hour,
    minute: rule.minute,
    anchorAt: rule.anchorAt,
    weekdays: rule.weekdays ?? [],
    monthDays: rule.monthDays ?? [],
    months: rule.months ?? [],
    monthlyMode: rule.monthlyMode ?? "date",
  };
}

export function AutomationEditView({
  editing,
  initialDraft,
  defaultWorkspacePath,
  defaultWorkspaceIdentity,
  onManageModels,
  saving,
  onSubmit,
  onBack,
  onRunNow,
  onToggle,
  onDelete,
  runsEntry,
  onLoadRuns,
  onDeleteRun,
  onOpenSession,
}: AutomationEditViewProps) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const [tab, setTab] = useState<AutomationSettingsHistoryTab>("settings");
  const [runsPage, setRunsPage] = useState(1);
  const onLoadRunsRef = useRef(onLoadRuns);
  const saveAndRunPendingRef = useRef(false);
  const [saveAndRunPending, setSaveAndRunPending] = useState(false);
  const localizedDefaultCreateTitle = intl.formatMessage({
    id: "automations.edit.titlePlaceholder",
  });
  const previousLocalizedDefaultTitleRef = useRef(localizedDefaultCreateTitle);
  const titleTouchedRef = useRef(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<string>("");
  const modelSelection = useRef("");
  const [mode, setMode] = useState<string>(AUTOMATION_DEFAULT_MODE);
  const modeRef = useRef(AUTOMATION_DEFAULT_MODE);
  const [thoughtLevel, setThoughtLevel] = useState<string>("");
  const thoughtLevelRef = useRef("");
  const modelManuallyChangedRef = useRef(false);
  const thoughtManuallyChangedRef = useRef(false);
  const thoughtTriggerRef = useRef<HTMLSpanElement | null>(null);
  // It is not possible to render the default "09:00 every day" in the first frame and then have the effect backfill the persistence schedule.
  // The child scheduling control will first register the value callback, thus mistaking the default value as dirty baseline; the editing state must use the real value in the first frame.
  const [builder, setBuilder] = useState<CronBuilderState>(() =>
    initialBuilder(editing, initialDraft),
  );
  // New tasks do not have a schedule by default and are explicitly added through "Add schedule"; after removal, the red prompt is not completed.
  const [scheduleRemoved, setScheduleRemoved] = useState(!editing && !initialDraft);
  const [validationErrors, setValidationErrors] = useState<
    ReadonlySet<AutomationEditRequiredField>
  >(() => new Set());
  const [customRepeatOpen, setCustomRepeatOpen] = useState(false);
  const [touchedFields, setTouchedFields] = useState<ReadonlySet<AutomationEditDirtyField>>(
    () => new Set(),
  );
  const currentEditSignaturesRef = useRef<AutomationEditFieldSignatures | null>(null);
  const touchedFieldBaselinesRef = useRef<Partial<AutomationEditFieldSignatures>>({});
  const [endAt, setEndAt] = useState<number | undefined>(() => editing?.endAt);
  // Target project key (can only be changed when creating a new project; editing is locked to the project to which automation belongs).
  const [workspaceKey, setWorkspaceKey] = useState<string | null>(null);

  const localWorkspaceOptions = useAutomationProjectOptions({
    includeConversationWorkspace: true,
  });
  const editingWorkspaceOption = editing
    ? findAutomationWorkspaceOptionByKey(localWorkspaceOptions, editing.workspaceKey)
    : undefined;
  const workspaceOptions = useMemo<AutomationWorkspaceOption[]>(
    () =>
      editing
        ? [
            {
              workspacePath: editing.workspacePath,
              workspaceIdentity: editing.workspaceIdentity,
              label: workspaceLabelFromPath(editing.workspacePath),
              ...(editingWorkspaceOption?.remoteSessionId
                ? { remoteSessionId: editingWorkspaceOption.remoteSessionId }
                : {}),
              ...(editingWorkspaceOption?.remoteTarget
                ? { remoteTarget: editingWorkspaceOption.remoteTarget }
                : {}),
              ...(editingWorkspaceOption?.workspacePurpose
                ? { workspacePurpose: editingWorkspaceOption.workspacePurpose }
                : {}),
            },
          ]
        : localWorkspaceOptions,
    [editing, editingWorkspaceOption, localWorkspaceOptions],
  );
  const workspaceOptionsRef = useRef(workspaceOptions);
  workspaceOptionsRef.current = workspaceOptions;

  // Reset the form when opening/switching the edit object.
  useEffect(() => {
    setTab("settings");
    setRunsPage(1);
    setTouchedFields(new Set());
    setValidationErrors(new Set());
    touchedFieldBaselinesRef.current = {};
    if (editing) {
      setScheduleRemoved(false);
      titleTouchedRef.current = false;
      modelManuallyChangedRef.current = false;
      thoughtManuallyChangedRef.current = false;
      setTitle(editing.title);
      setPrompt(editing.prompt);
      const editingModel = editing.modelSelection
        ? encodeCustomModelValue(editing.modelSelection.providerId, editing.modelSelection.modelId)
        : "";
      const editingThoughtLevel = editing.modelSelection?.options?.reasoningLevel?.trim() ?? "";
      modelSelection.current = editingModel;
      thoughtLevelRef.current = editingThoughtLevel;
      setModel(editingModel);
      const editingMode = editing.mode?.trim() || AUTOMATION_DEFAULT_MODE;
      modeRef.current = editingMode;
      setMode(editingMode);
      setThoughtLevel(editingThoughtLevel);
      setBuilder(initialBuilder(editing, initialDraft));
      setEndAt(editing.endAt);
      setWorkspaceKey(
        resolveWorkspaceKey({
          workspacePath: editing.workspacePath,
          workspaceIdentity: editing.workspaceIdentity,
        }),
      );
    } else {
      setScheduleRemoved(!initialDraft);
      // The default title for new pages can be updated with the locale; the template title remains something explicitly selected by the user.
      titleTouchedRef.current = false;
      modelManuallyChangedRef.current = false;
      thoughtManuallyChangedRef.current = false;
      setTitle(initialDraft?.title ?? localizedDefaultCreateTitle);
      setPrompt(initialDraft?.prompt ?? "");
      modelSelection.current = "";
      setModel("");
      modeRef.current = AUTOMATION_DEFAULT_MODE;
      thoughtLevelRef.current = "";
      setMode(AUTOMATION_DEFAULT_MODE);
      setThoughtLevel("");
      setBuilder(initialBuilder(editing, initialDraft));
      setEndAt(undefined);
      setWorkspaceKey(
        reconcileAutomationWorkspaceSelectionKey(workspaceOptionsRef.current, null, {
          workspacePath: defaultWorkspacePath,
          workspaceIdentity: defaultWorkspaceIdentity,
        }),
      );
    }
  }, [editing, initialDraft, defaultWorkspacePath, defaultWorkspaceIdentity]);

  useEffect(() => {
    const nextTitle = resolveLocalizedAutomationCreateTitle({
      currentTitle: title,
      hasInitialDraft: Boolean(initialDraft),
      isEditing: Boolean(editing),
      nextDefaultTitle: localizedDefaultCreateTitle,
      previousDefaultTitle: previousLocalizedDefaultTitleRef.current,
      titleTouched: titleTouchedRef.current,
    });
    previousLocalizedDefaultTitleRef.current = localizedDefaultCreateTitle;
    if (nextTitle !== title) {
      setTitle(nextTitle);
    }
  }, [editing, initialDraft, localizedDefaultCreateTitle, title]);

  useEffect(() => {
    if (editing) return;
    // When the candidate is empty or the default project has expired, the default workspace cannot be retained and the library is allowed to be dropped.
    // Any tab changes reconverge the selection to the currently valid items; if there are no candidates, they must be explicitly left blank.
    setWorkspaceKey((currentWorkspaceKey) =>
      reconcileAutomationWorkspaceSelectionKey(workspaceOptions, currentWorkspaceKey, {
        workspacePath: defaultWorkspacePath,
        workspaceIdentity: defaultWorkspaceIdentity,
      }),
    );
  }, [defaultWorkspaceIdentity, defaultWorkspacePath, editing, workspaceOptions]);

  const markFieldTouched = useCallback((field: AutomationEditDirtyField) => {
    if (touchedFieldBaselinesRef.current[field] === undefined) {
      touchedFieldBaselinesRef.current[field] = currentEditSignaturesRef.current?.[field];
    }
    setTouchedFields((previous) => {
      if (previous.has(field)) return previous;
      const next = new Set(previous);
      next.add(field);
      return next;
    });
  }, []);

  const clearRequiredFieldValidation = useCallback((field: AutomationEditRequiredField) => {
    setValidationErrors((current) => clearAutomationEditRequiredFieldError(current, field));
  }, []);

  const handleRemoveSchedule = useCallback(() => {
    markFieldTouched("schedule");
    setScheduleRemoved(true);
    // The deletion plan once directly turned on the destructive check state, mistaking ordinary editing for a submission failure.
    clearRequiredFieldValidation("schedule");
    logger.debug("[AutomationEditView] clear schedule draft", {
      automationId: editing?.automationId ?? null,
      validationVisible: false,
    });
  }, [clearRequiredFieldValidation, editing?.automationId, markFieldTouched]);

  useEffect(() => {
    onLoadRunsRef.current = onLoadRuns;
  }, [onLoadRuns]);

  // The running history is loaded when switching to the History tab (editing mode), and lightly refreshed during the stay.
  // cron run/outcome is written asynchronously by scheduler/host; loading it just once will show the user that the session has ended but the history is still empty.
  // onLoadRuns is passed inline from the parent component and cannot be used as a dependency, otherwise the effect will be restarted every time runsCache is updated to form a request loop.
  useEffect(() => {
    if (tab !== "history" || !editing) {
      return;
    }
    onLoadRunsRef.current?.();
    const timer = window.setInterval(() => {
      onLoadRunsRef.current?.();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [tab, editing?.automationId]);

  const isSessionCreatedAutomation = resolveIsSessionCreatedAutomation(editing);
  // Old crons that the session originated from but cannot be safely echoed by the UI remain read-only; the path is exited with a persistence token after an explicit reset by the user.
  const preserveSessionCreatedSchedule =
    isSessionCreatedAutomation &&
    !editing?.scheduleEditedByUser &&
    Boolean(editing && !canVisualizeCronInAutomationEditor(editing.cronExpr)) &&
    !touchedFields.has("schedule");
  const cronExpr = useMemo(
    () =>
      scheduleRemoved
        ? ""
        : preserveSessionCreatedSchedule
          ? (editing?.cronExpr ?? "")
          : buildCronExpr(builder),
    [builder, editing?.cronExpr, preserveSessionCreatedSchedule, scheduleRemoved],
  );
  const schedulePreview = useMemo(
    () => (cronExpr ? describeCronBuilder(builder, intl) : ""),
    [builder, cronExpr, intl],
  );
  const selectedWorkspace =
    findAutomationWorkspaceOptionByKey(workspaceOptions, workspaceKey) ??
    (editing
      ? {
          workspacePath: editing.workspacePath,
          workspaceIdentity: editing.workspaceIdentity,
          label: workspaceLabelFromPath(editing.workspacePath),
        }
      : null);
  // Reuse the empty item selection menu of the input box: map the form's item candidates to its tab structure.
  const workspaceMenuTabs = useMemo<ChatEmptyWorkspaceMenuTab[]>(
    () =>
      workspaceOptions.map((option) => ({
        workspacePath: option.workspacePath,
        label: option.label,
        ...(option.workspaceIdentity ? { workspaceIdentity: option.workspaceIdentity } : {}),
        ...(option.workspacePurpose ? { workspacePurpose: option.workspacePurpose } : {}),
      })),
    [workspaceOptions],
  );
  // When there is no valid project in the new state, the empty target is retained to prevent model configuration reading from silently falling back to conversation/default workspace.
  const selectedWorkspacePath = selectedWorkspace?.workspacePath ?? "";
  const selectedWorkspaceIdentity = selectedWorkspace?.workspaceIdentity;
  const originalSelection = useMemo(() => {
    if (!model) return null;
    const identity = parseModelPickerValue(model);
    return identity
      ? { ...identity, ...(thoughtLevel ? { options: { reasoningLevel: thoughtLevel } } : {}) }
      : null;
  }, [model, thoughtLevel]);
  // The model candidate belongs to the current form target Host. Switch subscriptions immediately when switching projects; when the remote target is not connected
  // useModelSelectionView will remain unavailable and must not fall back to the Local Host of the current settings page.
  const modelSelectionRead = useModelSelectionView(
    selectedWorkspacePath || null,
    selectedWorkspace?.remoteSessionId,
    selectedWorkspaceIdentity,
    selectedWorkspace?.remoteTarget,
    { selection: originalSelection },
  );
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const effectiveSelection = modelSelectionView?.effectiveSelection;
  const effectiveModelValue = effectiveSelection
    ? encodeCustomModelValue(effectiveSelection.providerId, effectiveSelection.modelId)
    : "";
  const effectiveReasoningLevel = effectiveSelection?.options?.reasoningLevel ?? "";
  const modelSelectGroups = useMemo(() => {
    if (!modelSelectionView) return [];
    return buildAutomationModelSelectGroups({
      selectedProvider: ZCODE_AGENT_PROVIDER,
      labels: {
        apiKeyLabel: intl.formatMessage({ id: "settings.modelProvider.apiKey" }),
        apiKeyBadgeLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.apiKeyBadge",
        }),
        codingPlanLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.codingPlan",
        }),
        codingPlanBadgeLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.codingPlanBadge",
        }),
        startPlanLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.startPlan",
        }),
        startPlanBadgeLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.startPlanBadge",
        }),
        teamPlanBadgeLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.teamPlanBadge",
        }),
        teamPlanFallbackLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.teamPlan",
        }),
      },
      registrySelectionView: modelSelectionView,
    });
  }, [intl, modelSelectionView]);
  const isSelectedConversationWorkspace = selectedWorkspace?.workspacePurpose === "conversation";
  // Automation data only persists workspaceKey/path, and the editing state directly saves conversation
  // backing path When the project is displayed as default. After matching the current canonical candidate recovery purpose,
  // Continue to reuse session side copy; historical targets that cannot be matched still fall back to path names.
  const selectedWorkspaceDisplayLabel = isSelectedConversationWorkspace
    ? intl.formatMessage({ id: "chat.empty.workOutsideProject" })
    : (selectedWorkspace?.label ?? workspaceLabelFromPath(defaultWorkspacePath));
  const conversationWorkspace = workspaceOptions.find(
    (option) => option.workspacePurpose === "conversation",
  );
  const handleSelectWorkspace = (workspace: ChatEmptyWorkspaceMenuTab) => {
    modelManuallyChangedRef.current = false;
    thoughtManuallyChangedRef.current = false;
    modelSelection.current = "";
    setModel("");
    // The remote workspace can share the same actual path; the old callback only passes the path and then finds it, and the first one will always be hit.
    // candidate. Selection events must carry identity to ensure that model previews, saves, and dispatches use the workspaceKey clicked by the user.
    setWorkspaceKey(resolveAutomationWorkspaceSelectionKey(workspace));
  };
  const handleSelectConversationWorkspace = () => {
    if (!conversationWorkspace) return;
    modelManuallyChangedRef.current = false;
    thoughtManuallyChangedRef.current = false;
    modelSelection.current = "";
    setModel("");
    // The conversation backing workspace was demoted to a normal project named default.
    // Causes menus to leak internal directory names and folder icons. Here press purpose to select canonical backing,
    // Presentation is given to the fixed "Not working on project" menu item on the session side.
    setWorkspaceKey(resolveAutomationWorkspaceSelectionKey(conversationWorkspace));
  };
  const modelTriggerLabel = resolveAutomationModelTriggerLabel({
    modelGroups: modelSelectGroups,
    modelSelectionView,
    modelValue: effectiveModelValue,
    fallbackLabel: intl.formatMessage({ id: "chat.toolbar.model.label" }),
  });
  // The highest gear is initialized only when the model is actively selected; missing gears are still retained during history restoration and View refresh.
  const handleModelValueChange = useCallback(
    (value: string) => {
      modelManuallyChangedRef.current = true;
      thoughtManuallyChangedRef.current = false;
      modelSelection.current = value;
      setModel(value);
      const selection =
        value && modelSelectionView
          ? completeNewModelSelection(modelSelectionView, parseModelPickerValue(value))
          : undefined;
      const level = selection?.options?.reasoningLevel ?? "";
      thoughtLevelRef.current = level;
      setThoughtLevel(level);
      markFieldTouched("model");
    },
    [markFieldTouched, modelSelectionView],
  );
  // The scheduled task editing page only maintains form drafts and cannot call the workspace default configuration interface to read options;
  // Otherwise, if the user only opens and cancels, the model, mode and thinking intensity of the current project or draft session will also be changed.
  const modeOption = useMemo(() => buildAutomationModeOption(mode), [mode]);
  const selectedModelItem = useMemo(
    () => resolveAutomationModelItem(modelSelectGroups, effectiveModelValue),
    [effectiveModelValue, modelSelectGroups],
  );
  const preferredModelValue = useMemo(
    () => (modelSelectionView ? resolveAutomationPreferredModelValue(modelSelectionView) : null),
    [modelSelectionView],
  );
  const persistedSelectionInvalid = Boolean(
    originalSelection && modelSelectionView && modelSelectionView.selectionIssue,
  );
  const invalidSelectionNoticeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!persistedSelectionInvalid || !editing || !modelSelectionView) return;
    const noticeKey = `${editing.automationId}:${modelSelectionView.revision}`;
    if (invalidSelectionNoticeKeyRef.current === noticeKey) return;
    invalidSelectionNoticeKeyRef.current = noticeKey;
    toast(intl.formatMessage({ id: "modelSelection.invalidated.reselect" }), {
      variant: "warning",
      position: "bottom-center",
      dedupeKey: `automation-model-selection-invalidated:${editing.automationId}`,
    });
  }, [editing, intl, modelSelectionView, persistedSelectionInvalid]);
  useEffect(() => {
    if (
      editing ||
      !preferredModelValue ||
      modelManuallyChangedRef.current ||
      persistedSelectionInvalid
    )
      return;
    if (model) return;
    // The old form saves the "default model" as a null value, but requires that specific candidates must exist before submission.
    // Causes the initial creation button to be permanently disabled. After the target Host is ready, directly select and solidify the preferredSelection.
    modelSelection.current = preferredModelValue;
    setModel(preferredModelValue);
    thoughtManuallyChangedRef.current = false;
    const preferredReasoning =
      modelSelectionView?.preferredSelection?.options?.reasoningLevel ?? "";
    thoughtLevelRef.current = preferredReasoning;
    setThoughtLevel(preferredReasoning);
  }, [editing, model, modelSelectionView, persistedSelectionInvalid, preferredModelValue]);
  const selectedModelMetadataThoughtOption = useMemo(() => {
    if (!selectedModelItem) return null;
    const decodedModel = decodeCustomModelValue(selectedModelItem.value);
    if (!decodedModel?.modelName) return null;
    // Reuse the same model static facts with session composer to avoid workspace runtime catalog not yet projected
    // thought_level, the scheduled task mistakenly displays the model that supports reasoning as a non-thinking level.
    return modelSelectionView
      ? resolveModelThoughtOption({
          modelSelectionView,
          providerId: decodedModel.providerId,
          modelId: decodedModel.modelName,
        })
      : null;
  }, [modelSelectionView, selectedModelItem]);
  // Option Specs for the selected model only come from the target Host View; no further deferred Sessions can be created for preview.
  const activeThoughtOption = selectedModelMetadataThoughtOption ?? undefined;
  const thoughtLevelOption = useMemo(
    () => buildAutomationThoughtLevelOption(activeThoughtOption, effectiveReasoningLevel),
    [activeThoughtOption, effectiveReasoningLevel],
  );

  const requiredFieldErrors = useMemo(
    () =>
      resolveAutomationEditRequiredFieldErrors({
        title,
        cronExpr,
        prompt,
      }),
    [cronExpr, prompt, title],
  );
  const hasValidWorkspace = Boolean(editing || selectedWorkspace);
  const submissionContextReady =
    hasValidWorkspace &&
    (Boolean(editing) || selectedWorkspace !== null) &&
    modelSelectionRead.state.status === "ready" &&
    selectedModelItem !== null &&
    Boolean(effectiveReasoningLevel) &&
    !modelSelectionView?.selectionIssue;
  const canSubmit = submissionContextReady && requiredFieldErrors.length === 0;

  const requestRequiredFieldValidation = useCallback(
    (source: "save" | "run-now") => {
      setValidationErrors(new Set(requiredFieldErrors));
      logger.debug("[AutomationEditView] validate required fields before submit", {
        automationId: editing?.automationId ?? null,
        source,
        invalidFields: requiredFieldErrors,
      });
      return requiredFieldErrors.length === 0;
    },
    [editing?.automationId, requiredFieldErrors],
  );

  const currentScheduleRule = useMemo<ZCodeAutomationScheduleRule | undefined>(
    () =>
      builder.frequency === "custom"
        ? {
            unit: builder.customUnit,
            interval: builder.customInterval,
            hour: builder.hour,
            minute: builder.minute,
            anchorAt: editing?.scheduleRule?.anchorAt ?? Date.now(),
            weekdays: builder.customWeekdays,
            monthDays: builder.customMonthDays,
            // months is only meaningful for yearly; if other units are empty, JSON.stringify will discard undefined.
            months: builder.customUnit === "yearly" ? [builder.customMonth] : undefined,
            monthlyMode: builder.customMonthlyMode,
          }
        : undefined,
    [builder, editing?.scheduleRule?.anchorAt],
  );

  const buildSubmitInput = useCallback(
    ({ modeValue }: { modeValue: string }): CreateAutomationInput | UpdateAutomationInput => {
      if (!effectiveSelection || !effectiveReasoningLevel) {
        throw new Error("Automation model selection is required");
      }
      return {
        title: title.trim(),
        cronExpr,
        prompt: prompt.trim(),
        // When editing a limited-time task created within a session, it cannot be permanently changed to a recurring task.
        recurring: editing?.recurring ?? true,
        ...(editing ? { endAt: endAt ?? null } : endAt ? { endAt } : {}),
        ...(editing
          ? preserveSessionCreatedSchedule
            ? {}
            : { scheduleRule: currentScheduleRule ?? null }
          : currentScheduleRule
            ? { scheduleRule: currentScheduleRule }
            : {}),
        ...(editing && touchedFields.has("schedule") ? { scheduleEditedByUser: true } : {}),
        mode: modeValue,
        modelSelection: effectiveSelection,
      };
    },
    [
      cronExpr,
      currentScheduleRule,
      editing,
      endAt,
      preserveSessionCreatedSchedule,
      prompt,
      effectiveSelection,
      effectiveReasoningLevel,
      title,
      touchedFields,
    ],
  );

  const currentEditSignatures = useMemo<AutomationEditFieldSignatures | null>(() => {
    if (!editing) return null;
    return {
      title: title.trim(),
      prompt: prompt.trim(),
      schedule: JSON.stringify({
        cronExpr,
        endAt: endAt ?? null,
        scheduleRule: preserveSessionCreatedSchedule
          ? null
          : normalizeAutomationScheduleRule(currentScheduleRule ?? null),
      }),
      mode,
      thoughtLevel,
      model,
    };
  }, [
    cronExpr,
    currentScheduleRule,
    editing,
    endAt,
    preserveSessionCreatedSchedule,
    mode,
    model,
    prompt,
    thoughtLevel,
    title,
  ]);
  currentEditSignaturesRef.current = currentEditSignatures;

  const changedFields = useMemo(
    () =>
      currentEditSignatures
        ? resolveChangedAutomationEditFields({
            touchedFields,
            current: currentEditSignatures,
            baseline: touchedFieldBaselinesRef.current,
          })
        : [],
    [currentEditSignatures, touchedFields],
  );
  // Model metadata and cron builder will be normalized asynchronously after opening the page; only those that have been actually operated by the user
  // Only the field can trigger the unsaved prompt, otherwise just opening an existing task and then returning will be misjudged as modification.
  const hasUnsavedChanges = Boolean(editing) && changedFields.length > 0;

  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView);
  const submitAutomation = useCallback(
    async (options: { validationSource: "save" | "run-now"; returnToList?: boolean }) => {
      if (saving) return false;
      if (!requestRequiredFieldValidation(options.validationSource)) {
        return false;
      }
      if (!canSubmit) return false;
      // This prevents the user from quickly saving the valid result of the previous input when the corresponding View has just been changed and the corresponding View has not been obtained.
      if (modelSelection.current !== model || thoughtLevelRef.current !== thoughtLevel)
        return false;
      const input: CreateAutomationInput | UpdateAutomationInput = {
        // The permission drop-down and save button are two independent controls. When saving immediately after quickly selecting Plan,
        // The React state may not have been refreshed to the submit closure; use ref to retain the last selection to avoid falling into the default build.
        ...buildSubmitInput({
          modeValue: modeRef.current,
        }),
      };
      // The original project is locked in the editing state; the selected project is used in the new state.
      const target = editing
        ? {
            workspacePath: editing.workspacePath,
            workspaceIdentity: editing.workspaceIdentity,
          }
        : selectedWorkspace
          ? {
              workspacePath: selectedWorkspace.workspacePath,
              workspaceIdentity: selectedWorkspace.workspaceIdentity,
            }
          : null;
      // Merely disabling a button cannot override shortcut keys or asynchronous callbacks; commit boundaries must also reject new creations without valid items.
      if (!target) return false;
      if (input.modelSelection && (!editing || changedFields.includes("model"))) {
        const chosen = await recommendStartPlan(input.modelSelection);
        if (!chosen) return false;
        input.modelSelection = chosen;
      }
      const trace = startUserAction({
        featureId: "automation.lifecycle",
        action: editing ? "update" : "create",
        trigger: "button",
        workspaceKind: editing?.workspaceIdentity?.trim() ? "remote" : "local",
        automationKind: "scheduled",
      });
      try {
        const ok = await onSubmit({ input, ...target });
        if (ok) {
          trace.complete({ resultSource: "platform_result" });
          if (options?.returnToList !== false) onBack();
        } else {
          trace.reject({ resultSource: "platform_result" });
        }
        return ok;
      } catch (error) {
        trace.fail({ failureStage: "automation_save" });
        throw error;
      }
    },
    [
      buildSubmitInput,
      changedFields,
      recommendStartPlan,
      canSubmit,
      editing,
      onBack,
      onSubmit,
      requestRequiredFieldValidation,
      saving,
      model,
      thoughtLevel,
      selectedWorkspace?.workspaceIdentity,
      selectedWorkspace?.workspacePath,
    ],
  );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await submitAutomation({ validationSource: "save" });
  };

  const handleSaveAndRun = useCallback(async () => {
    if (!editing || !onRunNow || saveAndRunPendingRef.current) return;
    saveAndRunPendingRef.current = true;
    setSaveAndRunPending(true);
    logger.debug("[AutomationEditView] save and run now start", {
      automationId: editing.automationId,
      changedFields,
    });
    try {
      const completed = await saveAndRunAutomation(
        () =>
          submitAutomation({
            returnToList: false,
            validationSource: "run-now",
          }),
        () => onRunNow(editing),
      );
      logger.debug("[AutomationEditView] save and run now end", {
        automationId: editing.automationId,
        completed,
      });
    } finally {
      saveAndRunPendingRef.current = false;
      setSaveAndRunPending(false);
    }
  }, [changedFields, editing, onRunNow, submitAutomation]);

  const handleBackClick = useCallback(async () => {
    logger.debug("[AutomationEditView] check unsaved changes before back", {
      automationId: editing?.automationId ?? null,
      touchedFields: [...touchedFields],
      changedFields,
    });
    if (!hasUnsavedChanges) {
      onBack();
      return;
    }

    // Scheduled tasks once maintained a separate "Save/Abandon Changes" pop-up window, and a confirmation pop-up window for idle tasks.
    // Sizes and actions continue to drift; remote Automation presentations are reused uniformly, retaining only "cancel/drop" semantics.
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "automations.unsaved.title" }),
      description: intl.formatMessage({
        id: "automations.unsaved.description",
      }),
      confirmLabel: intl.formatMessage({
        id: "automations.unsaved.discard",
      }),
      confirmVariant: "destructive",
      showCloseButton: true,
      showKeyboardHints: false,
      presentation: "automation-confirmation",
    });
    logger.debug("[AutomationEditView] unsaved changes confirmation result", {
      automationId: editing?.automationId ?? null,
      discarded: confirmed,
    });
    if (confirmed) onBack();
  }, [
    changedFields,
    confirmDialog,
    editing?.automationId,
    hasUnsavedChanges,
    intl,
    onBack,
    touchedFields,
  ]);

  const handleTabChange = useCallback(
    (nextTab: AutomationSettingsHistoryTab) => {
      // The History trigger was directly disabled when creating a new scheduled task, which was inconsistent with the interaction where idle tasks could view empty history.
      logger.debug("[AutomationEditView] switch settings tab", {
        automationId: editing?.automationId ?? null,
        nextTab,
        willLoadRuns: nextTab === "history" && Boolean(editing),
      });
      setTab(nextTab);
    },
    [editing],
  );

  const runs = runsEntry?.runs ?? [];
  const runsLoading = runsEntry?.status === "loading";
  // Running history client paging: The data has been loaded in its entirety and is displayed here by page slices. When the number of entries changes after deletion, the page numbers will be converged into the valid range.
  const runsTotalPages = Math.max(1, Math.ceil(runs.length / RUNS_PAGE_SIZE));
  const runsCurrentPage = Math.min(runsPage, runsTotalPages);
  const pagedRuns = runs.slice(
    (runsCurrentPage - 1) * RUNS_PAGE_SIZE,
    runsCurrentPage * RUNS_PAGE_SIZE,
  );
  const runsPageItems = buildRunsPageItems(runsCurrentPage, runsTotalPages);
  const editStatus = editing ? resolveAutomationStatusKind(editing) : null;
  const showEditingSettingsActions = Boolean(editing && tab === "settings");
  const showCreateSettingsAction = !editing && tab === "settings";

  return (
    <>
      <div className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "flex flex-col gap-6")}>
        <SettingsBreadcrumbReporter
          items={[
            {
              label: editing?.title ?? intl.formatMessage({ id: "automations.edit.newTask" }),
            },
          ]}
          onSectionSelect={() => void handleBackClick()}
        />

        <div className="space-y-1.5">
          <h1
            data-testid="automation-edit-title"
            className="text-ui-xl font-semibold text-foreground"
          >
            {intl.formatMessage({
              id: editing ? "automations.form.editTitle" : "automations.form.createTitle",
            })}
          </h1>
          <p data-testid="automation-edit-subtitle" className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({
              id: editing ? "automations.edit.editSubtitle" : "automations.edit.createSubtitle",
            })}
          </p>
        </div>

        {/* Tabs + actions on the right */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <AutomationSettingsHistoryTabs
            value={tab}
            settingsLabel={intl.formatMessage({
              id: "automations.edit.tab.settings",
            })}
            historyLabel={intl.formatMessage({
              id: "automations.edit.tab.history",
            })}
            onValueChange={handleTabChange}
          />

          <div className="flex items-center gap-1.5">
            {editing ? (
              <>
                {showEditingSettingsActions ? (
                  <button
                    type="submit"
                    form="automation-edit-form"
                    data-testid={TID_AUTOMATION_FORM_SUBMIT}
                    className="inline-flex h-8 items-center rounded-lg border-0 bg-white px-3 text-ui-base font-medium text-black shadow-none outline-none transition-colors hover:bg-white/90 focus-visible:ring-0 disabled:pointer-events-none disabled:opacity-40"
                    disabled={!submissionContextReady || saving}
                  >
                    {intl.formatMessage({
                      id: saving ? "automations.form.saving" : "automations.form.save",
                    })}
                  </button>
                ) : null}
                {showEditingSettingsActions && onRunNow ? (
                  <button
                    type="button"
                    data-testid={TID_AUTOMATION_RUN_NOW}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border-0 bg-white/[0.06] px-3 text-ui-base font-medium text-foreground shadow-none outline-none transition-colors hover:bg-white/10 focus-visible:ring-0 disabled:pointer-events-none disabled:cursor-not-allowed disabled:text-foreground-subtlest disabled:opacity-40"
                    disabled={!submissionContextReady || saving || saveAndRunPending}
                    onClick={() => void handleSaveAndRun()}
                  >
                    <AutomationRunNowIcon className="size-4" aria-hidden="true" />
                    {intl.formatMessage({ id: "automations.runNow" })}
                  </button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={intl.formatMessage({
                        id: "automations.moreActions",
                      })}
                      className="flex size-8 items-center justify-center rounded-lg border-0 bg-white/[0.06] text-foreground-subtle shadow-none outline-none transition-colors hover:bg-white/10 hover:text-foreground data-[state=open]:bg-white/10 data-[state=open]:text-foreground focus-visible:ring-0"
                    >
                      <AutomationMoreHorizontalIcon className="size-4" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={4} className="min-w-[180px]">
                    {/* Terminal-state tasks (completed/failed) show no pause/resume: Resume is meaningless for a terminal state, and saving it back would revive the task. */}
                    {onToggle &&
                    editing.lifecycleStatus !== "completed" &&
                    editing.lifecycleStatus !== "failed" ? (
                      <DropdownMenuItem
                        className="gap-1"
                        onSelect={() => onToggle(editing, !editing.enabled)}
                      >
                        <span className="flex size-5 items-center justify-center">
                          {editing.enabled ? (
                            <AutomationPauseActionIcon className="size-4" aria-hidden="true" />
                          ) : (
                            <AutomationContinueIcon className="size-4" aria-hidden="true" />
                          )}
                        </span>
                        {intl.formatMessage({
                          id: editing.enabled ? "automations.pause" : "automations.resume",
                        })}
                      </DropdownMenuItem>
                    ) : null}
                    {onDelete ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="gap-1 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
                          onSelect={() => onDelete(editing)}
                        >
                          <AutomationTrashIcon />
                          {intl.formatMessage({ id: "automations.delete" })}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : showCreateSettingsAction ? (
              <Button
                type="submit"
                form="automation-edit-form"
                variant="default"
                size="lg"
                data-testid={TID_AUTOMATION_FORM_SUBMIT}
                disabled={!canSubmit || saving}
              >
                {intl.formatMessage({
                  id: saving ? "automations.form.saving" : "automations.edit.createButton",
                })}
              </Button>
            ) : null}
          </div>
        </div>

        {tab === "settings" ? (
          <form
            id="automation-edit-form"
            className="space-y-4"
            onSubmit={(e) => void handleSubmit(e)}
          >
            {editStatus ? (
              <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
                <div className="text-ui-base font-normal leading-5 text-foreground-subtle">
                  {intl.formatMessage({ id: "automations.form.status.label" })}
                </div>
                <div className="flex min-h-8 flex-wrap items-center gap-2">
                  {/* The status dot and pill carried over oversized 8px / 36px dimensions instead of following the 6px glyph + 20px frame spec. */}
                  <span className="inline-flex h-8 max-w-full items-center gap-1 rounded-lg bg-card pl-2 pr-4 text-ui-base leading-5 text-foreground">
                    <span className="flex size-5 shrink-0 items-center justify-center">
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          AUTOMATION_STATUS_DOT_CLASS[editStatus],
                        )}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="min-w-0 truncate">
                      {intl.formatMessage({
                        id: `automations.lifecycle.${editStatus}`,
                      })}
                    </span>
                  </span>
                </div>
              </div>
            ) : null}

            {/* Task title */}
            <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
              <label
                className="text-ui-base font-normal leading-5 text-foreground-subtle"
                htmlFor="automation-title"
              >
                {intl.formatMessage({ id: "automations.form.title.label" })}
              </label>
              {/* The Task title is a standard Input, so the global outline semantics cannot be removed locally. */}
              <Input
                id="automation-title"
                size="lg"
                data-testid={TID_AUTOMATION_FORM_TITLE}
                value={title}
                onChange={(e) => {
                  titleTouchedRef.current = true;
                  markFieldTouched("title");
                  clearRequiredFieldValidation("title");
                  setTitle(e.target.value);
                }}
                placeholder={intl.formatMessage({
                  id: "automations.edit.titlePlaceholder",
                })}
                aria-invalid={validationErrors.has("title") && !title.trim()}
                maxLength={200}
                className={cn(
                  "h-9 rounded-xl bg-input px-3 text-foreground",
                  AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,
                )}
              />
            </div>

            {/* Legacy crons originating from a session cannot be echoed back reliably; they were removed in favor of the standard UI schedule-editing flow. */}
            {preserveSessionCreatedSchedule ? (
              <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
                <label className="inline-flex items-center gap-1.5 text-ui-base font-normal leading-5 text-foreground-subtle">
                  {intl.formatMessage({
                    id: "automations.form.schedule.label",
                  })}
                </label>
                <div
                  data-testid={TID_AUTOMATION_SCHEDULE_PREVIEW}
                  className="relative flex h-9 items-center overflow-hidden rounded-xl border border-input-border bg-input px-2 pr-9 text-ui-base leading-5 text-foreground-subtle transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused"
                >
                  <span className="min-w-0 truncate">
                    {intl.formatMessage({ id: "automations.frequency.custom" })}
                  </span>
                  <button
                    type="button"
                    data-testid={TID_AUTOMATION_SCHEDULE_DELETE}
                    onClick={handleRemoveSchedule}
                    className="absolute right-2 top-2 flex size-5 items-center justify-center text-foreground-subtle transition-colors hover:text-foreground"
                    aria-label={intl.formatMessage({ id: "common.delete" })}
                  >
                    <AutomationTrashIcon />
                  </button>
                </div>
              </div>
            ) : (
              <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
                <label className="inline-flex items-center gap-1.5 text-ui-base font-normal leading-5 text-foreground-subtle">
                  {intl.formatMessage({
                    id: "automations.form.schedule.label",
                  })}
                </label>
                {scheduleRemoved ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        data-testid={TID_AUTOMATION_SCHEDULE_ADD}
                        aria-invalid={scheduleRemoved && validationErrors.has("schedule")}
                        className={cn(
                          "flex h-9 w-full items-center gap-1 rounded-xl border bg-input px-2 text-ui-base font-normal leading-5 text-foreground-subtle transition-colors hover:border-input-border-hover hover:text-foreground focus-visible:border-input-border-focused focus-visible:bg-input-focused data-[state=open]:border-input-border-focused data-[state=open]:bg-input-focused data-[state=open]:text-foreground",
                          validationErrors.has("schedule")
                            ? "!border-destructive !ring-2 !ring-destructive/20"
                            : "border-input-border",
                        )}
                      >
                        <span className="flex size-5 shrink-0 items-center justify-center">
                          <AutomationAddScheduleIcon aria-hidden="true" />
                        </span>
                        {intl.formatMessage({
                          id: "scheduledPreview.addSchedule",
                        })}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" sideOffset={4} className="w-[148px] p-1.5">
                      {FREQUENCIES.map((frequency) => (
                        <DropdownMenuItem
                          key={frequency}
                          data-testid={testId(TID_AUTOMATION_FREQUENCY_OPTION, frequency)}
                          // raw white 5% is only visible in dark menus, and the highlighted state under Light is approximately transparent.
                          className="min-h-8 px-2 py-2 text-ui-base text-foreground-subtle data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground"
                          onSelect={() => {
                            markFieldTouched("schedule");
                            if (frequency === "custom") {
                              setCustomRepeatOpen(true);
                              return;
                            }
                            setBuilder((previous) => ({
                              ...previous,
                              frequency,
                              ...(frequency === "weekdays" ? { weekdays: [1, 2, 3, 4, 5] } : {}),
                            }));
                            setScheduleRemoved(false);
                            clearRequiredFieldValidation("schedule");
                          }}
                        >
                          {intl.formatMessage({
                            id: `automations.frequency.${frequency}`,
                          })}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <>
                    {/* The schedule bar uses no min-height, wrapping layout, or full-row summary — those get pushed
                        taller by a second row once tags are added. After the global Input's 1px
                        outline is restored, a 7px left padding offsets the border's footprint,
                        keeping the first tag 8px from the outer edge as before; after tags gain 1px
                        of top and bottom padding they still sit vertically centered inside the 36px
                        input.
                        */}
                    <div className="relative flex h-9 flex-nowrap items-center gap-1 overflow-hidden rounded-xl border border-input-border bg-input py-1 pl-[7px] pr-9 text-ui-base leading-5 text-foreground transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused">
                      <Select
                        value={builder.frequency}
                        onValueChange={(value) => {
                          // Radix Select may emit null values ​​during the control registration phase of editing an old cron and cannot override resolved frequencies.
                          if (!isCronFrequency(value)) {
                            logger.warn(
                              "[AutomationEditView] ignore invalid frequency selection value",
                              {
                                automationId: editing?.automationId,
                                cronExpr: editing?.cronExpr,
                                value,
                              },
                            );
                            return;
                          }
                          markFieldTouched("schedule");
                          if (value === "custom") {
                            setCustomRepeatOpen(true);
                            return;
                          }
                          setBuilder((prev) => ({
                            ...prev,
                            frequency: value,
                            ...(value === "weekdays" ? { weekdays: [1, 2, 3, 4, 5] } : {}),
                          }));
                        }}
                      >
                        {/* The frequency trigger used hard-coded dark values, which made contrast inaccurate in light
                            themes; it now uses hover/selected semantic tokens plus 1px of top and
                            bottom padding on top of the 20px line height.
                            */}
                        <SelectTrigger
                          variant="ghost"
                          data-testid={TID_AUTOMATION_FREQUENCY_SELECT}
                          className="h-auto min-w-24 rounded-full border-0 bg-hover py-px pl-2 text-ui-base leading-5 text-foreground hover:bg-selected aria-expanded:bg-selected"
                          indicator={<AutomationChevronDownIcon />}
                        >
                          <SelectValue>
                            {intl.formatMessage({
                              id: `automations.frequency.${builder.frequency}`,
                            })}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {FREQUENCIES.map((freq) => (
                            <SelectItem
                              key={freq}
                              value={freq}
                              data-testid={testId(TID_AUTOMATION_FREQUENCY_OPTION, freq)}
                            >
                              {intl.formatMessage({
                                id: `automations.frequency.${freq}`,
                              })}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {builder.frequency === "monthly" ? (
                        <Select
                          value={String(builder.dayOfMonth)}
                          onValueChange={(value) => {
                            markFieldTouched("schedule");
                            setBuilder((prev) => ({
                              ...prev,
                              dayOfMonth: Number(value),
                            }));
                          }}
                        >
                          <SelectTrigger
                            variant="ghost"
                            className="h-auto w-auto rounded-full border-0 bg-hover py-px pl-2 pr-0.5 text-ui-base leading-5 text-foreground hover:bg-selected aria-expanded:bg-selected"
                            indicator={<AutomationChevronDownIcon />}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="max-h-60">
                            {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                              <SelectItem key={day} value={String(day)}>
                                {intl.formatMessage(
                                  { id: "automations.form.dayOfMonth" },
                                  { day: String(day) },
                                )}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : null}

                      {builder.frequency === "weekly" ? (
                        <WeekdayPicker
                          weekdays={builder.weekdays}
                          intl={intl}
                          onChange={(weekdays) => {
                            markFieldTouched("schedule");
                            setBuilder((prev) => ({ ...prev, weekdays }));
                          }}
                        />
                      ) : null}

                      {/* The recurrence period used a hard-coded #F8F8F8 and its three tag radii were inconsistent; the semantic text color and pill radius are now unified. */}
                      {builder.frequency === "custom" ? (
                        <button
                          type="button"
                          // The visual reconstruction mistakenly deleted the E2E stable selector, resulting in the inability to reopen Custom Repeat to verify the restored value after saving.
                          data-testid={TID_AUTOMATION_CUSTOM_REPEAT_EDIT}
                          onClick={() => setCustomRepeatOpen(true)}
                          className="inline-flex h-auto items-center gap-0.5 rounded-full bg-hover py-px pl-2 pr-0.5 text-ui-base leading-5 text-foreground hover:bg-selected"
                        >
                          <span>
                            {intl.formatMessage(
                              {
                                id: "automations.customRepeat.compactFrequency",
                              },
                              {
                                interval: String(builder.customInterval),
                                unit: intl.formatMessage({
                                  id: `automations.customRepeat.unit.${
                                    builder.customUnit === "minute"
                                      ? "minute"
                                      : builder.customUnit === "daily"
                                        ? "day"
                                        : builder.customUnit === "weekly"
                                          ? "week"
                                          : builder.customUnit === "monthly"
                                            ? "month"
                                            : builder.customUnit === "yearly"
                                              ? "year"
                                              : "hour"
                                  }`,
                                }),
                              },
                            )}
                          </span>
                          <AutomationChevronDownIcon />
                        </button>
                      ) : null}

                      {builder.frequency !== "custom" && builder.frequency !== "hourly" ? (
                        <>
                          {/* The conjunction used a secondary color on its own, which formed a wrong highlight break with the primary text of the adjacent tag. */}
                          <span className="text-foreground">
                            {intl.formatMessage({
                              id: "automations.form.schedule.at",
                            })}
                          </span>
                          <TimeOfDayPicker
                            hour={builder.hour}
                            minute={builder.minute}
                            ariaLabel={intl.formatMessage({
                              id: "automations.form.schedule.label",
                            })}
                            onChange={(hour, minute) => {
                              markFieldTouched("schedule");
                              setBuilder((prev) => ({ ...prev, hour, minute }));
                            }}
                          />
                          <span className="whitespace-nowrap text-foreground-subtle">
                            {formatGmtOffset()}
                          </span>
                        </>
                      ) : null}

                      {builder.frequency === "hourly" ? (
                        <div className="flex items-center gap-1 text-ui-base leading-5 text-foreground">
                          <span>
                            {intl.formatMessage({
                              id: "automations.form.schedule.minutePrefix",
                            })}
                          </span>
                          <Select
                            value={String(builder.minute)}
                            onValueChange={(value) => {
                              markFieldTouched("schedule");
                              setBuilder((prev) => ({
                                ...prev,
                                minute: Number(value),
                              }));
                            }}
                          >
                            <SelectTrigger
                              variant="ghost"
                              className="h-auto w-14 rounded-full border-0 bg-hover py-px pl-2 text-ui-base leading-5 tabular-nums hover:bg-selected"
                            >
                              <SelectValue>{pad2(builder.minute)}</SelectValue>
                            </SelectTrigger>
                            <SelectContent className="max-h-60">
                              {Array.from({ length: 60 }, (_, value) => (
                                <SelectItem key={value} value={String(value)}>
                                  {pad2(value)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <span>
                            {intl.formatMessage({
                              id: "automations.form.schedule.minuteSuffix",
                            })}
                          </span>
                        </div>
                      ) : null}

                      {builder.frequency === "custom" && builder.customUnit === "hourly" ? (
                        <div className="flex items-center gap-1 text-ui-base leading-5 text-foreground">
                          <span>
                            {intl.formatMessage({
                              id: "automations.form.schedule.at",
                            })}
                          </span>
                          <Select
                            value={String(builder.minute)}
                            onValueChange={(value) => {
                              markFieldTouched("schedule");
                              setBuilder((prev) => ({
                                ...prev,
                                minute: Number(value),
                              }));
                            }}
                          >
                            <SelectTrigger
                              variant="ghost"
                              className="h-auto w-16 rounded-full border-0 bg-hover py-px pl-2 text-ui-base leading-5 tabular-nums hover:bg-selected"
                            >
                              <SelectValue>{pad2(builder.minute)}</SelectValue>
                            </SelectTrigger>
                            <SelectContent className="max-h-60">
                              {Array.from({ length: 60 }, (_, value) => (
                                <SelectItem key={value} value={String(value)}>
                                  {pad2(value)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <span>
                            {intl.formatMessage({
                              id: "automations.customRepeat.minutes",
                            })}
                          </span>
                        </div>
                      ) : null}

                      {builder.frequency === "custom" && builder.customUnit === "yearly" ? (
                        <MonthDayPicker
                          month={builder.customMonth}
                          day={builder.customMonthDays[0] ?? 1}
                          intl={intl}
                          onChange={(month, day) => {
                            markFieldTouched("schedule");
                            setBuilder((prev) => ({
                              ...prev,
                              customMonth: month,
                              customMonthDays: [day],
                            }));
                          }}
                        />
                      ) : null}

                      {builder.frequency === "custom" &&
                      builder.customUnit !== "hourly" &&
                      builder.customUnit !== "minute" ? (
                        <>
                          <span className="text-foreground">
                            {intl.formatMessage({
                              id: "automations.form.schedule.at",
                            })}
                          </span>
                          <TimeOfDayPicker
                            hour={builder.hour}
                            minute={builder.minute}
                            onChange={(hour, minute) => {
                              markFieldTouched("schedule");
                              setBuilder((prev) => ({ ...prev, hour, minute }));
                            }}
                          />
                          <span className="text-foreground-subtle">{formatGmtOffset()}</span>
                        </>
                      ) : null}

                      {schedulePreview ? (
                        <span
                          data-testid={TID_AUTOMATION_SCHEDULE_PREVIEW}
                          className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle sm:ml-1"
                        >
                          {schedulePreview}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        data-testid={TID_AUTOMATION_SCHEDULE_DELETE}
                        onClick={handleRemoveSchedule}
                        className="absolute right-2 top-2 flex size-5 items-center justify-center text-foreground-subtle transition-colors hover:text-foreground"
                        aria-label={intl.formatMessage({ id: "common.delete" })}
                      >
                        <AutomationTrashIcon />
                      </button>
                    </div>
                  </>
                )}

                <CustomRepeatDialog
                  builder={builder}
                  endAt={endAt}
                  intl={intl}
                  open={customRepeatOpen}
                  onOpenChange={setCustomRepeatOpen}
                  onConfirm={({
                    interval,
                    unit,
                    weekdays,
                    monthDays,
                    monthlyMode,
                    endAt: nextEndAt,
                  }) => {
                    markFieldTouched("schedule");
                    setScheduleRemoved(false);
                    clearRequiredFieldValidation("schedule");
                    setBuilder((prev) => ({
                      ...prev,
                      frequency: "custom",
                      customInterval: interval,
                      customUnit: unit,
                      customWeekdays: weekdays,
                      customMonthDays: monthDays,
                      customMonthlyMode: monthlyMode,
                    }));
                    setEndAt(nextEndAt);
                  }}
                />
              </div>
            )}

            {/* Instructions + the project/model selectors at the bottom */}
            <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
              <label
                className="text-ui-base font-normal leading-5 text-foreground-subtle"
                htmlFor="automation-prompt"
              >
                {intl.formatMessage({ id: "automations.form.prompt.label" })}
              </label>
              <AutomationInstructionsComposer
                invalid={validationErrors.has("prompt") && !prompt.trim()}
              >
                <AutomationInstructionsTextarea
                  id="automation-prompt"
                  data-testid={TID_AUTOMATION_FORM_PROMPT}
                  value={prompt}
                  onChange={(event) => {
                    markFieldTouched("prompt");
                    clearRequiredFieldValidation("prompt");
                    setPrompt(event.target.value);
                  }}
                  placeholder={intl.formatMessage({
                    id: "automations.edit.promptPlaceholder",
                  })}
                  aria-invalid={validationErrors.has("prompt") && !prompt.trim()}
                />
                <AutomationInstructionsToolbar>
                  <div className="flex min-w-0 flex-wrap items-center gap-0 text-foreground-subtle">
                    {/* Project selector: when creating, reuse the project menu of the input's empty state; when editing, lock it to the automation's own project */}
                    {editing ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled
                        className="h-auto min-h-7 gap-1 rounded-full px-2 py-1 text-ui-base font-normal leading-normal"
                      >
                        {isSelectedConversationWorkspace ? (
                          <MessageCircle className="size-3.5" aria-hidden="true" />
                        ) : (
                          <FolderOpen className="size-3.5" aria-hidden="true" />
                        )}
                        <span className="max-w-40 truncate">{selectedWorkspaceDisplayLabel}</span>
                      </Button>
                    ) : workspaceMenuTabs.length > 0 ? (
                      // The Automations toolbar and session composer control use rounded-lg uniformly, and the normal session chip remains unchanged.
                      <ChatEmptyWorkspacePreviewMenu
                        workspacePath={selectedWorkspacePath}
                        workspaceTabs={workspaceMenuTabs}
                        // The scheduled task allows the option of canonical conversation backing, but does not provide the shortcut X on the chip;
                        // The menu display uniformly reuses the "not working in project" text and MessageCircle icon on the session side.
                        allowConversationWorkspaceSelection={Boolean(conversationWorkspace)}
                        allowConversationWorkspaceDetach={false}
                        onSelectWorkspace={handleSelectWorkspace}
                        onSelectConversationWorkspace={handleSelectConversationWorkspace}
                        allowOpenWorkspace={false}
                        allowRemoteWorkspace={false}
                        onOpenFolder={() => {}}
                        onConnectRemote={async () => ""}
                        onSelectRemoteProject={async () => {}}
                        onCancelRemoteProject={async (_sessionId) => {}}
                        containerClassName="contents"
                        triggerClassName={cn(
                          AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                          "min-w-0 gap-1 px-2",
                        )}
                      />
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled
                        className="h-auto min-h-7 gap-1 rounded-full px-2 py-1 text-ui-base font-normal leading-normal text-foreground-subtlest"
                      >
                        <FolderOpen className="size-3.5" aria-hidden="true" />
                        {intl.formatMessage({
                          id: "automations.form.project.localRequired",
                        })}
                      </Button>
                    )}

                    {/* The automation page once copied the home page's permission menu, which let the icons, font
                        sizes, and selected states gradually diverge. It reuses the home page's
                        ConfigSelect directly, overriding only the compact trigger layout.
                        */}
                    <ConfigSelect
                      option={modeOption}
                      onValueChange={(value) => {
                        markFieldTouched("mode");
                        modeRef.current = value;
                        setMode(value);
                      }}
                      tooltipTitle={intl.formatMessage({
                        id: "chat.toolbar.mode.label",
                      })}
                      triggerVariant="ghost"
                      triggerSize="default"
                      triggerClassName={cn(
                        AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                        "w-fit max-w-56 min-w-0 shrink justify-start gap-1 px-2",
                      )}
                      labelVisibilityClassName="inline-flex min-w-0 truncate text-left"
                      provider={ZCODE_AGENT_PROVIDER}
                      restoreFocusSelector={null}
                    />
                  </div>

                  {/* Model / reasoning effort are grouped on the right, forming a clear division from workspace / permissions on the left. */}
                  <div className="flex min-w-0 flex-wrap items-center justify-end gap-0 text-foreground-subtle">
                    <ModelConfigSelect
                      modelGroups={modelSelectGroups}
                      normalizedValue={selectedModelItem?.value ?? ""}
                      triggerLabel={modelTriggerLabel}
                      showManageModelsAction={Boolean(onManageModels)}
                      lockReasonMessage=""
                      isItemLocked={MODEL_ITEM_NEVER_LOCKED}
                      onValueChange={handleModelValueChange}
                      tooltipTitle={intl.formatMessage({
                        id: "chat.toolbar.model.label",
                      })}
                      manageModelsLabel={intl.formatMessage({
                        id: "chat.toolbar.model.manageModels",
                      })}
                      onManageModels={onManageModels}
                      contentSide="top"
                      focusSelectorOnClose={null}
                      labelVisibilityClassName="hidden @sm/composer:inline-flex"
                      indicatorClassName="hidden @sm/composer:block"
                      triggerClassName={cn(
                        AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                        "w-fit max-w-72 min-w-0 shrink @max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:gap-0 @max-sm/composer:p-0",
                      )}
                      triggerIconClassName="inline-flex @sm/composer:hidden"
                      disabled={modelSelectionRead.state.status !== "ready"}
                    />
                    {modelSelectionRead.state.status === "error" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={modelSelectionRead.reload}
                      >
                        {intl.formatMessage({ id: "common.retry" })}
                      </Button>
                    ) : null}
                    {thoughtLevelOption ? (
                      <ThoughtLevelCycleControl
                        intl={intl}
                        option={thoughtLevelOption}
                        provider={ZCODE_AGENT_PROVIDER}
                        triggerRef={thoughtTriggerRef}
                        indicatorClassName="hidden @xl/composer:block"
                        triggerClassName={cn(
                          AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                          "@max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:p-0",
                        )}
                        restoreFocusSelector={null}
                        labelVisibilityClassName="hidden @xl/composer:inline-flex"
                        onValueChange={(value) => {
                          if (!effectiveSelection) return;
                          markFieldTouched("thoughtLevel");
                          // When the user changes gears, a new intention is formed in the identity of the displayed model; read-only refresh does not change the form.
                          modelSelection.current = effectiveModelValue;
                          setModel(effectiveModelValue);
                          thoughtManuallyChangedRef.current = true;
                          thoughtLevelRef.current = value;
                          setThoughtLevel(value);
                        }}
                      />
                    ) : null}
                  </div>
                </AutomationInstructionsToolbar>
              </AutomationInstructionsComposer>
            </div>
          </form>
        ) : (
          // History tab: Run history inline table
          <div>
            {/* Run conditions are already explained at the settings entry; repeating the hint on the history page would eat into the space above the table. */}
            {runsLoading && runs.length === 0 ? (
              <div className="flex h-32 items-center justify-center">
                <Spinner className="size-5" />
              </div>
            ) : runsEntry?.status === "error" ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
                {runsEntry.error}
              </div>
            ) : runs.length === 0 ? (
              // The cron job once rendered only a transparent block of py-10 text, lacking the empty background, border, and height consistent with the idle job.
              <AutomationHistoryEmptyState>
                {intl.formatMessage({ id: "automations.runs.empty" })}
              </AutomationHistoryEmptyState>
            ) : (
              <div className="overflow-x-auto rounded-[8px]">
                {/* Run history uses scalable font sizes, so it cannot stay bound to a fixed 18px line height. */}
                <table className="w-full text-left text-ui-base font-normal leading-normal tracking-[-0.08px]">
                  <thead className="bg-surface text-foreground-subtle">
                    <tr className="h-[30px] border-b border-border">
                      <th className="px-4 font-normal">
                        {intl.formatMessage({
                          id: "automations.runs.col.triggered",
                        })}
                      </th>
                      <th className="px-4 font-normal">
                        {intl.formatMessage({
                          id: "automations.runs.col.trigger",
                        })}
                      </th>
                      <th className="px-4 font-normal">
                        {intl.formatMessage({
                          id: "automations.runs.col.status",
                        })}
                      </th>
                      <th className="px-4 font-normal">
                        {intl.formatMessage({
                          id: "automations.runs.col.duration",
                        })}
                      </th>
                      <th className="px-4 font-normal" />
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRuns.map((run) => {
                      const status = resolveRunStatus(run);
                      const statusLabel = intl.formatMessage({
                        id: `automations.runs.status.${status}`,
                      });
                      const statusBadge = (
                        <span className="flex items-center text-ui-base leading-5 tracking-[-0.18px]">
                          <span className="flex size-5 shrink-0 items-center justify-center">
                            <span
                              className={cn(
                                "inline-block size-1.5 rounded-full",
                                RUN_STATUS_DOT_CLASS[status],
                              )}
                            />
                          </span>
                          <span className={RUN_STATUS_TEXT_CLASS[status]}>{statusLabel}</span>
                        </span>
                      );
                      const canOpenSession = Boolean(run.sessionId && onOpenSession);
                      const hasActions = canOpenSession || Boolean(onDeleteRun);
                      return (
                        <tr
                          key={run.runId}
                          className="h-[46px] border-b border-border transition-colors last:border-b-0 hover:bg-surface-hover"
                        >
                          <td className="whitespace-nowrap px-4 text-foreground-subtle">
                            {formatDateTime(run.scheduledAt ?? run.createdAt)}
                          </td>
                          <td className="whitespace-nowrap px-4 text-foreground-subtle">
                            {intl.formatMessage({
                              id: `automations.trigger.${run.trigger}`,
                            })}
                          </td>
                          <td className="px-4">
                            {status === "failed" ? (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>{statusBadge}</TooltipTrigger>
                                  <TooltipContent
                                    side="top"
                                    align="start"
                                    sideOffset={6}
                                    className="max-w-96 whitespace-normal break-words"
                                  >
                                    {run.error?.trim() ||
                                      intl.formatMessage({
                                        id: "automations.runs.errorUnavailable",
                                      })}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            ) : (
                              statusBadge
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 text-foreground-subtle">
                            {formatDuration(run.createdAt, run.updatedAt)}
                          </td>
                          <td className="px-4">
                            <div className="flex items-center justify-end">
                              {hasActions ? (
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button
                                      type="button"
                                      aria-label={intl.formatMessage({
                                        id: "automations.moreActions",
                                      })}
                                      className="flex size-6 items-center justify-center rounded-[6px] text-foreground-subtle transition-colors hover:bg-white/10 hover:text-foreground data-[state=open]:bg-white/10 data-[state=open]:text-foreground"
                                    >
                                      <AutomationMoreHorizontalIcon
                                        className="size-4"
                                        aria-hidden="true"
                                      />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent
                                    align="end"
                                    sideOffset={4}
                                    className="min-w-[160px]"
                                  >
                                    {canOpenSession ? (
                                      <DropdownMenuItem
                                        onSelect={() => onOpenSession?.(run.sessionId!)}
                                      >
                                        <AutomationExternalLinkIcon
                                          className="size-3.5"
                                          aria-hidden="true"
                                        />
                                        {intl.formatMessage({
                                          id: "automations.runs.openSession",
                                        })}
                                      </DropdownMenuItem>
                                    ) : null}
                                    {onDeleteRun ? (
                                      <>
                                        {canOpenSession ? <DropdownMenuSeparator /> : null}
                                        <DropdownMenuItem
                                          variant="destructive"
                                          onSelect={() => onDeleteRun(run.runId)}
                                        >
                                          <AutomationTrashIcon />
                                          {intl.formatMessage({
                                            id: "automations.runs.delete",
                                          })}
                                        </DropdownMenuItem>
                                      </>
                                    ) : null}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {runs.length > 0 && runsTotalPages > 1 ? (
              <nav className="mt-4 flex items-center justify-between text-ui-base">
                <button
                  type="button"
                  disabled={runsCurrentPage <= 1}
                  onClick={() => setRunsPage(Math.max(1, runsCurrentPage - 1))}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-foreground-subtle transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  <ArrowLeft className="size-3.5" aria-hidden="true" />
                  {intl.formatMessage({ id: "automations.runs.prevPage" })}
                </button>
                <div className="flex items-center gap-1">
                  {runsPageItems.map((item, index) =>
                    item === "ellipsis" ? (
                      <span
                        key={`ellipsis-${index}`}
                        className="flex size-7 items-center justify-center text-foreground-subtlest"
                        aria-hidden="true"
                      >
                        …
                      </span>
                    ) : (
                      <button
                        key={item}
                        type="button"
                        aria-current={item === runsCurrentPage ? "page" : undefined}
                        onClick={() => setRunsPage(item)}
                        className={cn(
                          "inline-flex size-7 items-center justify-center rounded-[6px] transition-colors",
                          item === runsCurrentPage
                            ? "bg-surface text-foreground"
                            : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                        )}
                      >
                        {item}
                      </button>
                    ),
                  )}
                </div>
                <button
                  type="button"
                  disabled={runsCurrentPage >= runsTotalPages}
                  onClick={() => setRunsPage(Math.min(runsTotalPages, runsCurrentPage + 1))}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-foreground-subtle transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  {intl.formatMessage({ id: "automations.runs.nextPage" })}
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </button>
              </nav>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}
