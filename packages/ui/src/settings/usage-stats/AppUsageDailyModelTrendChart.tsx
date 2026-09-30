import { type ComponentProps, useCallback, useMemo } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import type { AppUsageSnapshot } from "@zcode/shared";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  UsageEmptyState,
  formatCompactTokenUsage,
  formatDay,
  resolveModelLabel,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import { getAppUsageModelChartColor } from "@/settings/usage-stats/appUsageChartPalette.js";

// The first and last XAxis scales are centered on the boundary of the drawing area and extend to both sides. The original 8px margin is less than half the width of the date text.
// SVG will cut off the first and last text; leave a 24px safe area on the left and right, allowing the short date to be fully displayed on both the desktop and mobile web.
export const APP_USAGE_TREND_CHART_MARGIN = {
  top: 8,
  right: 24,
  left: 24,
} as const;

type DailyModelChartRow = {
  label: string;
  tooltipLabel: string;
  total: number;
} & Record<string, number | string>;

type ModelChartKey = {
  modelId: string | null;
  key: string;
  color: string;
  label: string;
};
type UsageIntl = ReturnType<typeof useZCodeIntl>["intl"];
type ChartTooltipContentProps = ComponentProps<typeof ChartTooltipContent>;

export function filterDailyModelTooltipPayload<T extends { value?: unknown }>(
  payload: readonly T[] | undefined,
): T[] {
  // Recharts’ multi-sequence tooltip payload will include all models of the day;
  // There is no visible trend point in the 0 usage model, and continuing to display it will mislead the user into thinking that the hover has reached the effective usage.
  return (payload ?? []).filter((item) => {
    const value = typeof item.value === "number" ? item.value : Number(item.value);
    return Number.isFinite(value) && value > 0;
  });
}

export function resolveDailyModelTooltipTokenParts(
  locale: string,
  value: unknown,
  tokenUnit: string,
): { number: string; unit: string } {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return { number: String(value), unit: "" };
  }
  return {
    number: formatCompactTokenUsage(locale, numericValue),
    unit: tokenUnit,
  };
}

function shouldShowDailyChartAxisLabel(index: number, total: number): boolean {
  if (total <= 14) {
    return true;
  }
  const step = total > 45 ? 7 : 5;
  return index === 0 || index === total - 1 || index % step === 0;
}

function createEmptyChartRow(label: string, tooltipLabel: string, modelKeys: ModelChartKey[]) {
  const row: DailyModelChartRow = {
    label,
    tooltipLabel,
    total: 0,
  };

  for (const model of modelKeys) {
    row[model.key] = 0;
  }

  return row;
}

function buildDailyModelChartData({
  snapshot,
  locale,
  modelKeys,
  modelKeyById,
}: {
  snapshot: AppUsageSnapshot;
  locale: string;
  modelKeys: ModelChartKey[];
  modelKeyById: Map<string, string>;
}): DailyModelChartRow[] {
  const rows = new Map<string, DailyModelChartRow>();

  // The 30d protocol result of App Usage is already a daily sequence, and the old all bucketing remains
  // The 30-day weekly aggregate aggregates into approximately 5 points, resulting in no continuous daily trend for the "Last 30 Days".
  for (const day of snapshot.dailyModelUsage) {
    const label = formatDay(locale, day.date);
    const row = rows.get(day.date) ?? createEmptyChartRow(label, label, modelKeys);

    for (const model of day.models) {
      const key = modelKeyById.get(model.modelId ?? "__unknown__");
      if (key) {
        row[key] = Number(row[key] ?? 0) + model.totalTokens;
      }
      row.total += model.totalTokens;
    }

    rows.set(day.date, row);
  }

  return [...rows.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => row);
}

export function buildAppUsageDailyModelChartViewModel({
  intl,
  locale,
  snapshot,
}: {
  intl: UsageIntl;
  locale: string;
  snapshot: AppUsageSnapshot;
}) {
  const topModels = snapshot.models.slice(0, 6);
  const modelKeys = topModels.map((model, index) => ({
    modelId: model.modelId,
    key: `model${index}`,
    color: getAppUsageModelChartColor(index),
    label: resolveModelLabel(intl, model.modelId),
  }));
  const modelKeyById = new Map(
    modelKeys.map((model) => [model.modelId ?? "__unknown__", model.key]),
  );
  const chartConfig = modelKeys.reduce<ChartConfig>((config, model) => {
    config[model.key] = {
      label: model.label,
      color: model.color,
    };
    return config;
  }, {});
  const chartData = buildDailyModelChartData({
    snapshot,
    locale,
    modelKeys,
    modelKeyById,
  });
  let maxTokens = 0;
  // The picture is an independent line rather than a stacked chart. Using daily totals will sum up multiple models (and models not shown)
  // Serves as a Y-axis upper limit, causing the actual visible curve to be pressed at the bottom; the coordinate range should only follow the single-point peak of the visible sequence.
  for (const row of chartData) {
    for (const model of modelKeys) {
      maxTokens = Math.max(maxTokens, Number(row[model.key] ?? 0));
    }
  }

  return {
    topModels,
    modelKeys,
    chartConfig,
    chartData,
    maxTokens,
  };
}

function DailyModelChartTooltipContent(props: ChartTooltipContentProps) {
  const filteredPayload = useMemo(
    () => filterDailyModelTooltipPayload(props.payload),
    [props.payload],
  );

  if (!props.active || filteredPayload.length === 0) {
    return null;
  }

  return <ChartTooltipContent {...props} payload={filteredPayload} />;
}

export function AppUsageDailyModelTrendChart({ snapshot }: { snapshot: AppUsageSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const { topModels, modelKeys, chartConfig, chartData, maxTokens } = useMemo(
    // Recharts 3.8 will write data / legend / graphical item props to the internal store.
    // The derived array and configuration object are stably derived here to avoid internal dispatch being triggered repeatedly due to reference changes when the parent component is re-rendered.
    () => buildAppUsageDailyModelChartViewModel({ intl, locale, snapshot }),
    [intl, locale, snapshot],
  );
  const shouldShowAxisLabel = useCallback(
    (_value: string, index: number) =>
      shouldShowDailyChartAxisLabel(index, chartData.length) ? _value : "",
    [chartData.length],
  );
  const formatTooltipLabel = useCallback(
    (_: unknown, payload: readonly { payload?: unknown }[]) => {
      const row = payload[0]?.payload as DailyModelChartRow | undefined;
      const total = typeof row?.total === "number" ? row.total : 0;
      return `${row?.tooltipLabel ?? ""} - ${formatCompactTokenUsage(locale, total)} ${intl.formatMessage(
        {
          id: "settings.usage.tokenUnit",
        },
      )}`;
    },
    [intl, locale],
  );
  const tokenUnit = intl.formatMessage({ id: "settings.usage.tokenUnit" });
  const formatTooltipItem = useCallback(
    (value: unknown, name: unknown, item: { color?: string }) => {
      const itemName = String(name);
      const label = chartConfig[itemName]?.label ?? itemName;
      const color = item.color ?? `var(--color-${itemName})`;
      const tokenValue = resolveDailyModelTooltipTokenParts(locale, value, tokenUnit);
      return (
        <>
          <span
            className="size-2 shrink-0 self-center rounded-full"
            style={{ backgroundColor: color }}
          />
          <div className="flex flex-1 items-center justify-between gap-3">
            <span className="text-foreground-subtle">{label}</span>
            <span className="flex items-baseline gap-1 text-foreground">
              <span className="font-mono font-medium tabular-nums">{tokenValue.number}</span>
              {tokenValue.unit ? (
                <span className="text-foreground-subtle">{tokenValue.unit}</span>
              ) : null}
            </span>
          </div>
        </>
      );
    },
    [chartConfig, locale, tokenUnit],
  );
  const tooltipContent = useMemo(
    () => (
      <DailyModelChartTooltipContent
        indicator="line"
        labelFormatter={formatTooltipLabel}
        formatter={formatTooltipItem}
      />
    ),
    [formatTooltipItem, formatTooltipLabel],
  );

  return (
    <section className="space-y-3 rounded-xl bg-surface p-4">
      <h3 className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.dailyChartTitle" })}
      </h3>
      {maxTokens <= 0 ? (
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.emptyDescription",
          })}
        />
      ) : (
        <div className="px-3 py-3">
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2" role="list">
            {topModels.map((model, index) => (
              <div
                key={model.modelId ?? "__unknown__"}
                className="flex min-w-0 items-center gap-2 text-ui-sm"
                role="listitem"
              >
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{
                    backgroundColor: getAppUsageModelChartColor(index),
                  }}
                />
                <span className="truncate text-foreground-subtle">
                  {resolveModelLabel(intl, model.modelId)}
                </span>
              </div>
            ))}
          </div>
          <ChartContainer config={chartConfig} className="h-60 w-full">
            <LineChart accessibilityLayer data={chartData} margin={APP_USAGE_TREND_CHART_MARGIN}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                interval={0}
                minTickGap={0}
                tickMargin={8}
                tickFormatter={shouldShowAxisLabel}
              />
              <YAxis hide domain={[0, maxTokens]} />
              <ChartTooltip cursor={false} content={tooltipContent} />
              {modelKeys.map((model) => (
                <Line
                  key={model.key}
                  dataKey={model.key}
                  type="monotone"
                  stroke={`var(--color-${model.key})`}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              ))}
            </LineChart>
          </ChartContainer>
        </div>
      )}
    </section>
  );
}
