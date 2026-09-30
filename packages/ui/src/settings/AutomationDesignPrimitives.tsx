import { TID_AUTOMATION_CREATE_MANUALLY, TID_AUTOMATION_CREATE_MENU } from "@zcode/shared";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { AutomationSwitchToggle } from "@/settings/AutomationSwitchToggle.js";
import { AutomationChevronDownIcon, AutomationInfoIcon } from "@/settings/AutomationIcons.js";
import { Button } from "@/components/ui/button.js";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";

export {
  AutomationAddScheduleIcon,
  AutomationCancelActionIcon,
  AutomationChevronDownIcon,
  AutomationClockIcon,
  AutomationContinueIcon,
  AutomationEditActionIcon,
  AutomationExternalLinkIcon,
  AutomationIdleTimeIcon,
  AutomationInfoIcon,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationPausedIcon,
  AutomationRefreshIcon,
  AutomationRunNowIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationIcons.js";

// When space-y adds margin to an inline label, it will be affected by the font line box, and the actual visual spacing is smaller than the 6px of the design draft.
export const AUTOMATION_FORM_FIELD_CLASSNAME = "flex flex-col gap-1.5";

export type AutomationSettingsHistoryTab = "settings" | "history";

/**
 * The run-history empty state shared by Scheduled and Off-peak, so the transparent whitespace and
 * card container styles cannot drift apart again.
 */
export function AutomationHistoryEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[226px] items-center justify-center rounded-xl border border-dashed border-card-border bg-background px-4 text-center text-ui-base text-foreground-subtle">
      {children}
    </div>
  );
}

/**
 * The Scheduled and Off-peak settings pages reuse the pill visuals of the Hooks scope tabs, so the
 * detail-page section styles cannot drift.
 */
export function AutomationSettingsHistoryTabs({
  value,
  settingsLabel,
  historyLabel,
  onValueChange,
}: {
  value: AutomationSettingsHistoryTab;
  settingsLabel: string;
  historyLabel: string;
  onValueChange: (value: AutomationSettingsHistoryTab) => void;
}) {
  return (
    <SettingsSegmentedTabs
      value={value}
      items={[
        { value: "settings", label: settingsLabel },
        { value: "history", label: historyLabel },
      ]}
      onValueChange={onValueChange}
    />
  );
}

/**
 * The Keep-awake notice bar; the caller wires the toggle value into the globally shared settings
 * rather than a page-level mock store.
 */
export function AutomationKeepAwakeNotice({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  // The desktop breakpoint once cleared the vertical padding of the prompt bar, causing the actual style to deviate from the 12px specification.
  return (
    <div
      data-automations-keep-awake
      className="flex min-h-11 w-full items-center gap-3 overflow-hidden rounded-[10px] bg-surface px-3 py-3 text-foreground-subtle"
    >
      <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
        <AutomationInfoIcon className="size-4" />
      </span>
      <p className="min-w-0 flex-1 text-ui-base leading-5">
        {intl.formatMessage({ id: "offPeak.keepAwakeBanner" })}
      </p>
      <AutomationSwitchToggle
        checked={checked}
        ariaLabel={intl.formatMessage({ id: "offPeak.keepAwakeBanner" })}
        onChange={onChange}
        color="blue"
        size="sm"
      />
    </div>
  );
}

export function AutomationCreateDropdown({
  onViaChat,
  onManually,
}: {
  onViaChat: () => void;
  onManually: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <div className="inline-flex h-7 items-center overflow-hidden rounded-lg">
        <Button
          type="button"
          variant="default"
          size="default"
          className="rounded-none border-0"
          data-testid={TID_AUTOMATION_CREATE_MANUALLY}
          onClick={onManually}
        >
          {intl.formatMessage({ id: "automations.createManually" })}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="default"
            size="icon-md"
            data-testid={TID_AUTOMATION_CREATE_MENU}
            aria-label={intl.formatMessage({ id: "automations.create" })}
            className="!w-6 rounded-none border-0"
          >
            <AutomationChevronDownIcon size={14} />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" sideOffset={4} className="w-auto min-w-0">
        <DropdownMenuItem className="pr-6" onSelect={onViaChat}>
          {intl.formatMessage({ id: "automations.createViaChat" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
