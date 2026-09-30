import { Activity, List, ListChecks, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { ClientSceneLucideIcon } from "@/components/ClientSceneLucideIcon.js";

export type OffPeakTemplateIconName =
  | "standupGitSummary"
  | "ciFlakyReport"
  | "documentationSyncCheck"
  | "customize"
  | "standupGitSummarySecondary"
  | "followUpMonitor";

const OFF_PEAK_TEMPLATE_ICONS: Record<OffPeakTemplateIconName, LucideIcon> = {
  standupGitSummary: List,
  ciFlakyReport: Activity,
  // After merging release/current, a new document synchronization template is added; the checklist semantics are used to avoid directory and icon union type drift.
  documentationSyncCheck: ListChecks,
  customize: SlidersHorizontal,
  standupGitSummarySecondary: List,
  followUpMonitor: ListChecks,
};

/** The semantic icon mapping for the Automations case; the home case uniformly uses Moon. */
export function OffPeakTemplateIcon({
  className,
  iconName,
  name,
}: {
  className?: string;
  iconName?: string;
  name: OffPeakTemplateIconName;
}) {
  const Icon = OFF_PEAK_TEMPLATE_ICONS[name];
  return (
    <ClientSceneLucideIcon
      className={className}
      name={iconName}
      aria-hidden="true"
      size={16}
      strokeWidth={2}
      fallback={
        <Icon
          aria-hidden="true"
          className={className}
          data-off-peak-template-icon={name}
          size={16}
          strokeWidth={2}
        />
      }
    />
  );
}
