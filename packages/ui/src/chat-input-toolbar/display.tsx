/* eslint-disable max-lines -- Tool presentation */
import {
  useCallback,
  useMemo,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import {
  TID_CHAT_MODE_SELECT_ITEM,
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  testId,
  type ZCodeApiRetryStatus,
  type ZCodeConfigOption,
  type ZCodeConfigSelectValue,
  type ZCodeProvider,
} from "@zcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  isCoarseTouchDevice,
  shouldRestoreChatInputFocusAfterPickerClose,
} from "@/lib/pickerFocus.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  ChevronDownIcon,
  HandIcon,
  NotepadText,
  ShieldAlertIcon,
  ShieldCheckIcon,
  type LucideIcon,
} from "lucide-react";
import { ZCODE_MODE_OPTION_DESCRIPTION_IDS, ZCODE_MODE_OPTION_LABEL_IDS } from "./display-help.js";
import { RollingToolbarLabel } from "@/chat-input-toolbar/RollingToolbarLabel.js";

export {
  ChatContextUsage,
  getContextCompressionCommand,
  getRenderableTaskUsage,
} from "@/chat-input-toolbar/contextUsage.js";

type ConfigSelectTriggerSize = ComponentProps<typeof SelectTrigger>["size"];
type ConfigSelectTriggerVariant = ComponentProps<typeof SelectTrigger>["variant"];

/**
 * Radix Select can emit values that were never rendered, such as the empty value, when the
 * controlled value races with child registration; propagating them would mistake a system event for
 * a user selection (for example, merely opening the details in the Automations edit page would be
 * flagged as an unsaved change). A user can only click a rendered option, so every selection
 * callback outside the value domain is dropped.
 */
function isConfigSelectValueInOptions(option: ZCodeConfigOption, value: string): boolean {
  return option.options?.some((entry) => String(entry.value) === value) ?? false;
}

function getConfigSelectTriggerTestId(option: ZCodeConfigOption): string | undefined {
  if (option.category === "thought_level") {
    return TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER;
  }
  // Mode selector e2e anchor (used by v4 switchCollaborationMode link assertion).
  if (option.category === "mode") {
    return TID_CHAT_MODE_SELECT_TRIGGER;
  }

  return undefined;
}

function getConfigSelectItemTestId(
  option: ZCodeConfigOption,
  entry: ZCodeConfigSelectValue,
): string | undefined {
  if (option.category === "thought_level") {
    return testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, entry.value);
  }
  if (option.category === "mode") {
    return testId(TID_CHAT_MODE_SELECT_ITEM, entry.value);
  }

  return undefined;
}

export function ChatApiRetryStatus({
  apiRetry,
  intl,
  locale,
}: {
  apiRetry: ZCodeApiRetryStatus | null;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
}) {
  const retryLabel = useMemo(() => {
    if (!apiRetry) {
      return null;
    }

    // Currently, ZCode Agent will only push the retryDelayMs snapshot at a certain moment and will not decrease it every second.
    // Continuing to render this value as "Continue in X seconds" will give the user the illusion that the countdown is stuck.
    // Here we first converge to a stable retry status copy, and only show the number of retries.
    const formatter = new Intl.NumberFormat(locale);
    return intl.formatMessage(
      { id: "chat.apiRetryStatus" },
      {
        attempt: formatter.format(apiRetry.attempt),
        maxRetries: formatter.format(apiRetry.maxRetries),
      },
    );
  }, [apiRetry, intl, locale]);

  if (!apiRetry || !retryLabel) {
    return null;
  }

  const retryTitle =
    apiRetry.errorStatus == null ? retryLabel : `${retryLabel} · HTTP ${apiRetry.errorStatus}`;

  return (
    <span
      className="inline-flex h-7 items-center whitespace-nowrap px-1 text-ui-base"
      title={retryTitle}
    >
      {/*
      Retry must keep the ToolCall/Thinking font size, the sweep rhythm, and the low-opacity trough
      of the motion, but as a secondary run state it must not use equally extreme
      pure-black/pure-white peaks; here only the peak is lowered to the secondary text color.
      */}
      <span className="animated-gradient-text animated-gradient-text-subtle font-medium">
        {retryLabel}
      </span>
    </span>
  );
}

export function getModeOptionDisplayLabel(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  provider: ZCodeProvider | undefined,
  entry: Pick<ZCodeConfigSelectValue, "name" | "value">,
): string {
  const labelMessageId = getModeOptionLabelMessageId(provider, entry);
  if (!labelMessageId) {
    return entry.name;
  }

  return intl.formatMessage({ id: labelMessageId });
}

function getModeOptionLabelMessageId(
  provider: ZCodeProvider | undefined,
  entry: Pick<ZCodeConfigSelectValue, "value">,
): string | null {
  if (!provider) {
    return null;
  }

  return ZCODE_MODE_OPTION_LABEL_IDS[provider]?.[entry.value] ?? null;
}

export function getModeOptionDescriptionMessageId(
  provider: ZCodeProvider | undefined,
  entry: Pick<ZCodeConfigSelectValue, "value">,
): string | null {
  if (!provider) {
    return null;
  }

  return ZCODE_MODE_OPTION_DESCRIPTION_IDS[provider]?.[entry.value] ?? null;
}

export function getConfigOptionEntryLabel(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  provider: ZCodeProvider | undefined,
  option: ZCodeConfigOption,
  entry: ZCodeConfigSelectValue,
): string {
  if (option.category === "mode") {
    return getModeOptionDisplayLabel(intl, provider, entry);
  }

  return entry.name;
}

function getConfigOptionEntryDescription(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  provider: ZCodeProvider | undefined,
  option: ZCodeConfigOption,
  entry: ZCodeConfigSelectValue,
): string | undefined {
  if (option.category !== "mode") {
    return entry.description;
  }

  const descriptionMessageId = getModeOptionDescriptionMessageId(provider, entry);
  if (descriptionMessageId) {
    return intl.formatMessage({ id: descriptionMessageId });
  }

  return entry.description;
}

function isHighPermissionModeValue(value: unknown): boolean {
  return value === "yolo";
}

export function resolveModeOptionIcon(value: unknown): LucideIcon {
  if (isHighPermissionModeValue(value)) {
    return ShieldAlertIcon;
  }

  // build corresponds to regular confirmation mode, using the confirmation icon.
  if (typeof value === "string" && value.toLocaleLowerCase() === "build") return HandIcon;
  if (typeof value === "string" && value.toLocaleLowerCase() === "plan") return NotepadText;

  if (typeof value === "string" && /^(auto|agent|autoEdit|edit)$/i.test(value)) {
    return ShieldCheckIcon;
  }

  return HandIcon;
}

export function ConfigSelect({
  option,
  onValueChange,
  open,
  onOpenChange,
  disabled,
  tooltipTitle,
  shortcutLabel,
  triggerRef,
  triggerClassName,
  indicatorClassName,
  triggerVariant = "ghost",
  triggerSize = "lg",
  leadingIcon: LeadingIcon,
  labelVisibilityClassName = "hidden @xl/composer:inline-flex",
  provider,
  restoreFocusSelector = '[data-testid="chat-input"]',
}: {
  option: ZCodeConfigOption;
  onValueChange: (value: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  tooltipTitle: string;
  shortcutLabel?: string;
  triggerRef?: RefObject<HTMLSpanElement | null>;
  triggerClassName?: string;
  indicatorClassName?: string;
  triggerVariant?: ConfigSelectTriggerVariant;
  triggerSize?: ConfigSelectTriggerSize;
  leadingIcon?: LucideIcon;
  labelVisibilityClassName?: string;
  provider?: ZCodeProvider;
  restoreFocusSelector?: string | null;
}) {
  const { intl } = useZCodeIntl();

  // Note: handleContentKeyDown must be called before early return.
  // Previously `if (option.type !== "select" ...) return null` was written before useCallback,
  // When option switches between select/non-select (or the options array changes from empty to non-empty),
  // The number of hooks executed by this component in this rendering is inconsistent with the last time. React will throw
  // "Rendered fewer hooks than expected" caused the toolbar area to crash.
  // Repair method: Move the early return down to after all hooks to ensure that the hook calling sequence is stable.
  const handleContentKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") {
      return;
    }

    const highlightedItem =
      event.currentTarget.querySelector<HTMLElement>(
        '[data-slot="select-item"][data-highlighted]',
      ) ??
      event.currentTarget.querySelector<HTMLElement>(
        '[data-slot="select-item"][data-state="checked"]',
      ) ??
      event.currentTarget.querySelector<HTMLElement>('[data-slot="select-item"]');

    if (!highlightedItem) {
      return;
    }

    event.preventDefault();
    highlightedItem.click();
  }, []);

  // early return must be after all hooks (see the reason for the crash explained in the comments above)
  if (option.type !== "select" || !option.options?.length) {
    return null;
  }

  const shouldUseToolbarFloatingSelect =
    option.category === "mode" || option.category === "thought_level";
  const shouldShowHighPermissionModeIcon =
    option.category === "mode" && isHighPermissionModeValue(option.currentValue);
  const ResolvedLeadingIcon =
    option.category === "mode" ? resolveModeOptionIcon(option.currentValue) : LeadingIcon;
  const resolvedTriggerClassName = cn(
    triggerClassName,
    shouldShowHighPermissionModeIcon &&
      // High-privilege mode requires that the warning text color be maintained in the toolbar to prevent users from ignoring the current risk level.
      // The icon is only responsible for replacing it with shield-alert, and the color status is still uniformly carried by the trigger to ensure that the hover/expanded state does not flash back to the default color.
      "text-warning hover:text-warning aria-expanded:text-warning",
  );
  const resolvedLeadingIconClassName = cn(
    "pointer-events-none size-4 text-current",
    shouldShowHighPermissionModeIcon && "text-warning",
  );

  const selectContentProps = shouldUseToolbarFloatingSelect
    ? {
        // If the mode / thought_level menu at the bottom of the chat toolbar continues to use the default item-aligned,
        // Because the trigger is close to the bottom edge of the window, the visual height will be compressed, resulting in inconsistent expansion direction and visible area.
        // Here, the popper is uniformly changed to expand upward and converge to a consistent 4px spacing to ensure that the two menus behave consistently.
        position: "popper" as const,
        side: "top" as const,
        align: "start" as const,
        sideOffset: 4,
        collisionPadding: 8,
        className: option.category === "mode" ? "w-64" : undefined,
      }
    : undefined;
  const triggerTestId = getConfigSelectTriggerTestId(option);
  const currentEntry = option.options.find((entry) => entry.value === option.currentValue);
  const currentValueLabel = currentEntry
    ? getConfigOptionEntryLabel(intl, provider, option, currentEntry)
    : String(option.currentValue ?? "");
  const thoughtLevelTextClassName =
    option.category === "thought_level" ? "first-letter:uppercase" : undefined;

  return (
    <Select
      open={open}
      onOpenChange={onOpenChange}
      value={String(option.currentValue)}
      onValueChange={(value) => {
        // See isConfigSelectValueInOptions: callbacks outside of the value range come from Radix internal competition, not user selection.
        if (!isConfigSelectValueInOptions(option, value)) {
          logger.warn("[ConfigSelect] ignoring out-of-range selection callback", {
            category: option.category,
            value,
          });
          return;
        }
        onValueChange(value);
      }}
      disabled={disabled}
    >
      <ControlHintTooltip title={tooltipTitle} shortcut={shortcutLabel} triggerRef={triggerRef}>
        <SelectTrigger
          variant={triggerVariant}
          size={triggerSize}
          className={resolvedTriggerClassName}
          indicator={
            <ChevronDownIcon
              className={cn(
                "pointer-events-none size-3.5 text-foreground-subtle",
                indicatorClassName,
              )}
            />
          }
          aria-label={tooltipTitle}
          data-testid={triggerTestId}
        >
          {ResolvedLeadingIcon ? (
            <ResolvedLeadingIcon className={resolvedLeadingIconClassName} />
          ) : null}
          <span className={labelVisibilityClassName}>
            {/* The mode menu items are now composite content: “icon + title + description”.
            If Radix keeps backfilling from ItemText automatically, the trigger would stuff the
            description into the button as well.
            */}
            {option.category === "mode" ? (
              <RollingToolbarLabel label={currentValueLabel} />
            ) : (
              <SelectValue>
                <span className={thoughtLevelTextClassName}>{currentValueLabel}</span>
              </SelectValue>
            )}
          </span>
        </SelectTrigger>
      </ControlHintTooltip>
      <SelectContent
        {...selectContentProps}
        onKeyDown={handleContentKeyDown}
        onCloseAutoFocus={(event) => {
          if (!restoreFocusSelector) {
            // Automations permission selector has no chat input box to restore; previously unconditional
            // preventDefault will eat up Radix's default "focus back to trigger" and keyboard focus
            // Drop down to body after closing the menu. When null, the default behavior is retained, returning focus to the trigger.
            return;
          }
          event.preventDefault();
          if (
            !shouldRestoreChatInputFocusAfterPickerClose({
              isCoarseTouchDevice: isCoarseTouchDevice(),
            })
          ) {
            return;
          }
          // When ConfigSelect is reused by a non-chat interface, closing the menu cannot force focus to the chat input box.
          const input = document.querySelector<HTMLElement>(restoreFocusSelector);
          logger.debug("[ConfigSelect] picker focus handoff", {
            category: option.category,
            restoreFocusSelector,
            targetFound: Boolean(input),
          });
          input?.focus();
        }}
      >
        {option.category === "mode"
          ? option.options.map((entry) => {
              const ModeIcon = resolveModeOptionIcon(entry.value);
              const optionLabel = getConfigOptionEntryLabel(intl, provider, option, entry);
              const optionDescription = getConfigOptionEntryDescription(
                intl,
                provider,
                option,
                entry,
              );

              return (
                <SelectItem
                  key={entry.value}
                  value={entry.value}
                  className="min-h-13 items-start gap-3 py-2 pl-2 pr-8"
                  data-testid={getConfigSelectItemTestId(option, entry)}
                >
                  <span className="flex min-w-0 items-start gap-3">
                    <ModeIcon className="mt-0.5 size-4.5 shrink-0 text-foreground" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-ui-base/relaxed text-foreground">
                        {optionLabel}
                      </span>
                      {optionDescription?.trim() ? (
                        <span className="line-clamp-2 text-ui-sm/relaxed text-foreground-subtle whitespace-nowrap">
                          {optionDescription}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </SelectItem>
              );
            })
          : option.options.map((entry) => (
              <SelectItem
                key={entry.value}
                value={entry.value}
                data-testid={getConfigSelectItemTestId(option, entry)}
              >
                <span className={thoughtLevelTextClassName}>
                  {getConfigOptionEntryLabel(intl, provider, option, entry)}
                </span>
              </SelectItem>
            ))}
      </SelectContent>
    </Select>
  );
}
