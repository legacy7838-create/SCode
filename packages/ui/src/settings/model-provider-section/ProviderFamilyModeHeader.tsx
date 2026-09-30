import {
  TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
  TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER,
  resolveModelProviderFamilySpecByProviderId,
  isStartPlanModelProviderId,
  testId,
  type ProviderFamilyConnectionSelectionSettings,
} from "@zcode/shared";
import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { connectionSelectionMatchesNavigationItem } from "@/settings/model-provider-section/useModelProviderNavigation.js";
import { resolveModelProviderNavLogo } from "@/settings/model-provider-section/utils.js";
import { ProviderLogo } from "./ProviderLogo.js";
import type { ModelProviderNavItem } from "./constants.js";

type ProviderFamilyConnectionOption = {
  key: string;
  label: string;
  item: Extract<ModelProviderNavItem, { type: "preset" | "codingPlan" | "teamPlan" }>;
  order: number;
};

export function ProviderFamilyDetailShell({
  header,
  children,
}: {
  header: ReactNode;
  children: ReactNode;
}) {
  if (!header) {
    return children;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {header}
      {children}
    </div>
  );
}

export function ProviderFamilyHeader({
  selectedNavItem,
  trailingAction,
}: {
  selectedNavItem: ModelProviderNavItem | null;
  trailingAction?: ReactNode;
}) {
  if (!selectedNavItem) {
    return null;
  }

  const providerId =
    selectedNavItem.type === "preset" ||
    selectedNavItem.type === "codingPlan" ||
    selectedNavItem.type === "teamPlan"
      ? selectedNavItem.presetId
      : null;
  if (!providerId) {
    return null;
  }

  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  if (!familySpec) {
    return null;
  }

  return (
    <div className="flex h-8 min-w-0 flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ProviderLogo logo={resolveModelProviderNavLogo(selectedNavItem)} className="size-5" />
        <h3 className="truncate text-ui-lg font-medium text-foreground">
          {selectedNavItem.type === "codingPlan" && isStartPlanModelProviderId(providerId)
            ? "Start Plan"
            : familySpec.label}
        </h3>
      </div>
      {/* Participate in outer line wrapping according to the inherent width of the full name of the team, which will leave the right side of the title empty but the entire group will be broken; use the basic width of the operation area to participate in allocation, and then let the name shrink in the remaining space. */}
      {trailingAction ? (
        <div className="min-w-0 max-w-full flex-1 basis-64">{trailingAction}</div>
      ) : null}
    </div>
  );
}

export function ProviderFamilyPlanModeSwitch({
  selectedNavItem,
  navigationItems,
  connectionSettingsFailed = false,
  connectionSelections,
  onSelectNavItem,
}: {
  selectedNavItem: ModelProviderNavItem | null;
  navigationItems: ModelProviderNavItem[];
  startPlanSubscriptionCount?: number;
  connectionSettingsFailed?: boolean;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  onSelectNavItem?: (item: ModelProviderNavItem) => void;
}) {
  const { intl } = useZCodeIntl();
  if (!selectedNavItem || !onSelectNavItem) {
    return null;
  }

  const providerId =
    selectedNavItem.type === "preset" ||
    selectedNavItem.type === "codingPlan" ||
    selectedNavItem.type === "teamPlan"
      ? selectedNavItem.presetId
      : null;
  if (
    !providerId ||
    (selectedNavItem.type === "codingPlan" && isStartPlanModelProviderId(providerId))
  ) {
    return null;
  }

  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  if (!familySpec) {
    return null;
  }

  const options = buildProviderFamilyConnectionOptions({
    familyId: familySpec.id,
    navigationItems,
    startPlanLabel: intl.formatMessage({
      id: "settings.modelProvider.connectionMode.startPlan",
    }),
    codingPlanLabel: intl.formatMessage({
      id: "settings.modelProvider.connectionMode.codingPlan",
    }),
    teamPlanFallbackLabel: intl.formatMessage({
      id: "settings.modelProvider.connectionMode.teamPlan",
    }),
  });
  if (options.length === 0) {
    return null;
  }

  // Team navigation entries may reuse personal providers; selected identities only come from paid selections in saved/committed ones.
  const selection = connectionSelections?.[familySpec.id];
  const selectedOption = selection
    ? options.find((option) =>
        connectionSelectionMatchesNavigationItem(familySpec.id, selection, option.item),
      )
    : undefined;
  if (options.length === 1 && selectedOption) return null;
  const connectionModeLabel = intl.formatMessage({
    id: connectionSettingsFailed
      ? "settings.modelProvider.connectionMode.loadFailed"
      : "settings.modelProvider.connectionMode",
  });

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <span
        className={[
          "inline-flex min-w-0 shrink-0 items-center gap-1 text-ui-base",
          connectionSettingsFailed ? "text-warning" : "text-foreground-subtle",
        ].join(" ")}
      >
        {connectionSettingsFailed ? <InfoIcon className="size-3.5 shrink-0" /> : null}
        <span className="truncate">{connectionModeLabel}</span>
      </span>
      <Select
        value={selectedOption?.key ?? ""}
        onValueChange={(optionKey) => {
          const option = options.find((item) => item.key === optionKey);
          if (!option) {
            return;
          }
          onSelectNavItem(option.item);
        }}
      >
        <SelectTrigger
          size="lg"
          // Fixed maximum width will truncate the full name in widescreen; the remaining space will be occupied first, and the line will wrap only when the basic width of the control is insufficient.
          className="min-w-0 max-w-fit flex-1 basis-12 justify-between"
          aria-label={connectionModeLabel}
          data-testid={TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER}
        >
          <SelectValue
            className="min-w-0 flex-1"
            placeholder={intl.formatMessage({
              id: "settings.modelProvider.codingPlan.purchase.selectPlan",
            })}
          >
            {selectedOption ? (
              <span className="min-w-0 truncate text-left">{selectedOption.label}</span>
            ) : null}
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="end" className="min-w-40 max-w-[calc(100vw-2rem)]">
          {options.map((option) => (
            <SelectItem
              key={option.key}
              value={option.key}
              className="min-w-0 whitespace-normal pr-8 [overflow-wrap:anywhere]"
              data-testid={testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, option.key)}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function buildProviderFamilyConnectionOptions({
  familyId,
  navigationItems,
  codingPlanLabel,
  teamPlanFallbackLabel,
}: {
  familyId: string;
  navigationItems: ModelProviderNavItem[];
  startPlanLabel: string;
  codingPlanLabel: string;
  teamPlanFallbackLabel: string;
}): ProviderFamilyConnectionOption[] {
  const options: ProviderFamilyConnectionOption[] = [];
  for (const item of navigationItems) {
    if (item.type !== "preset" && item.type !== "codingPlan" && item.type !== "teamPlan") {
      continue;
    }
    const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId);
    if (!familySpec || familySpec.id !== familyId) {
      continue;
    }
    if (item.type === "preset" || isStartPlanModelProviderId(item.presetId)) continue;
    if (item.type === "teamPlan") {
      options.push({
        key: item.key,
        item,
        label: formatTeamPlanConnectionLabel(item.teamPlanName, teamPlanFallbackLabel),
        order: 100 + options.length,
      });
      continue;
    }
    options.push({
      key: item.key,
      item,
      label: codingPlanLabel,
      order: 10,
    });
  }

  return options.sort((left, right) => left.order - right.order);
}

function formatTeamPlanConnectionLabel(
  teamPlanName: string | null | undefined,
  fallbackLabel: string,
): string {
  const normalized = teamPlanName?.trim();
  if (!normalized) {
    return fallbackLabel;
  }
  // The team project name has been provided by the equity interface. Additional splicing of English Plan will destroy the Chinese and custom names.
  return normalized;
}
