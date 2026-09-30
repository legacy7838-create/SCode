import type { AppUsageRange } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";

export const RANGE_OPTIONS: AppUsageRange[] = ["7d", "30d"];
export const USAGE_STATS_TABS_LIST_CLASS =
  "flex h-7 rounded-full bg-surface p-0.5 group-data-horizontal/tabs:h-7";
export const USAGE_STATS_TABS_TRIGGER_CLASS =
  "h-6 flex-none justify-center rounded-full border-transparent bg-transparent px-2.5 py-0 text-ui-sm font-medium text-foreground-subtle data-active:border-transparent data-active:bg-background data-active:text-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-background";

export function formatCompactNumber(locale: string, value: number): string {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return new Intl.NumberFormat(locale, {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}

export function formatCompactTokenUsage(locale: string, value: number): string {
  return formatCompactTokenNumber(locale, value);
}

export function formatSummaryCompactTokenUsage(locale: string, value: number): string {
  const formatted = formatCompactTokenUsage(locale, value);

  // The general compact format will paste the Chinese units directly after the numbers; the summary card and the adjacent duration and day indicators will uniformly retain the unit spacing.
  return locale.startsWith("zh") ? formatted.replace(/(?<=\d)(?=[万亿])/u, " ") : formatted;
}

export function formatPercent(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: value >= 0.1 ? 0 : 1,
  }).format(value);
}

export function formatDay(locale: string, dateKey: string | null): string {
  if (!dateKey) {
    return "--";
  }
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    // The BigModel monitor interface occasionally returns empty strings or dates in non-yyyy-MM-dd format,
    // Previously, passing it directly to Intl.DateTimeFormat would throw a RangeError and blow up the entire chart.
    return dateKey;
  }
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(date);
}

export function formatFullDay(locale: string, dateKey: string | null): string {
  if (!dateKey) {
    return "--";
  }
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return dateKey;
  }
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

export function formatMonth(locale: string, dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return dateKey.slice(5, 7);
  }
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "short",
  }).format(date);
}

export function resolveModelLabel(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  modelId: string | null,
): string {
  return modelId?.trim() || intl.formatMessage({ id: "settings.usage.unknownModel" });
}

export function UsageEmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
      <div className="text-ui-base font-medium text-foreground">{title}</div>
      <div className="mt-2 text-ui-base text-foreground-subtle">{description}</div>
    </div>
  );
}
