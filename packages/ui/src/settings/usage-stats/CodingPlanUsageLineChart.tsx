import { useCallback, useMemo } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import type { CodingPlanUsageGranularity } from "@zcode/shared";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  UsageEmptyState,
  formatCompactNumber,
  formatCompactTokenUsage,
} from "@/settings/usage-stats/usageStatsUiParts.js";

const LINE_CHART_COLORS = [
  "var(--color-usage-chart-1)",
  "var(--color-usage-chart-2)",
  "var(--color-usage-chart-3)",
  "var(--color-usage-chart-4)",
  "var(--color-usage-chart-5)",
  "var(--color-usage-chart-6)",
];
// The first and last XAxis scales are centered on the boundary of the drawing area and extend to both sides. If the left and right safety zones are too small, they will be cropped.
// The first and last date text of line charts such as System health.
const CODING_PLAN_LINE_CHART_MARGIN = { top: 8, right: 24, left: 24 } as const;

type CodingPlanLineChartRow = {
  label: string;
  time: string;
} & Record<string, number | string>;

function getLineChartColor(index: number): string {
  return LINE_CHART_COLORS[index % LINE_CHART_COLORS.length] ?? LINE_CHART_COLORS[0]!;
}

function formatChartTime(
  locale: string,
  value: string,
  granularity: CodingPlanUsageGranularity,
): string {
  if (granularity === "hour") {
    return value.slice(0, 5);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function shouldShowXAxisLabel(index: number, total: number): boolean {
  if (total <= 14) {
    return true;
  }
  const step = total > 45 ? 7 : 5;
  return index === 0 || index === total - 1 || index % step === 0;
}

function buildChartData(
  locale: string,
  xTime: string[],
  granularity: CodingPlanUsageGranularity,
  series: Array<{ key: string; values: number[] }>,
): CodingPlanLineChartRow[] {
  return xTime.map((time, index) => {
    const row: CodingPlanLineChartRow = {
      label: formatChartTime(locale, time, granularity),
      time,
    };
    for (const item of series) {
      row[item.key] = item.values[index] ?? 0;
    }
    return row;
  });
}

export function CodingPlanUsageLineChart({
  xTime,
  granularity,
  series,
  emptyDescription,
  valueKind = "count",
  showLegend = true,
}: {
  xTime: string[];
  granularity: CodingPlanUsageGranularity;
  series: Array<{ name: string; values: number[] }>;
  emptyDescription: string;
  valueKind?: "count" | "credit" | "speed" | "token";
  showLegend?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const visibleSeries = useMemo(
    // Recharts is sensitive to reference changes in series, legend, and tooltip props.
    // Stable derived data to avoid repeated replace updates in the internal store of the chart when the settings page is refreshed.
    () =>
      series.slice(0, 6).map((item, index) => ({
        ...item,
        key: `series${index}`,
        color: getLineChartColor(index),
      })),
    [series],
  );
  const maxValue = useMemo(
    () => Math.max(0, ...visibleSeries.flatMap((item) => item.values)),
    [visibleSeries],
  );

  const chartConfig = useMemo(
    () =>
      visibleSeries.reduce<ChartConfig>((config, item) => {
        config[item.key] = {
          label: item.name,
          color: item.color,
        };
        return config;
      }, {}),
    [visibleSeries],
  );
  const chartData = useMemo(
    () => buildChartData("en-US", xTime, granularity, visibleSeries),
    [granularity, visibleSeries, xTime],
  );
  const shouldShowAxisLabel = useCallback(
    (value: string, index: number) => (shouldShowXAxisLabel(index, chartData.length) ? value : ""),
    [chartData.length],
  );
  const formatTooltipItem = useCallback(
    (value: unknown, name: unknown, item: { color?: string }) => {
      const itemName = String(name);
      const label = chartConfig[itemName]?.label ?? itemName;
      const color = item.color ?? `var(--color-${itemName})`;
      return (
        <>
          <span
            className="size-2 shrink-0 self-center rounded-full"
            style={{ backgroundColor: color }}
          />
          <div className="flex flex-1 items-center justify-between gap-3">
            <span className="text-foreground-subtle">{label}</span>
            <span className="flex items-baseline gap-1 text-foreground">
              <span className="font-mono font-medium tabular-nums">
                {typeof value === "number"
                  ? valueKind === "token"
                    ? formatCompactTokenUsage("en-US", value)
                    : formatCompactNumber("en-US", value)
                  : String(value)}
              </span>
              {typeof value === "number" && valueKind === "speed" ? (
                <span className="text-foreground-subtle">tokens/s</span>
              ) : null}
            </span>
          </div>
        </>
      );
    },
    [chartConfig, valueKind],
  );
  const tooltipContent = useMemo(
    () => (
      <ChartTooltipContent
        indicator="line"
        labelFormatter={(label) => String(label)}
        formatter={formatTooltipItem}
      />
    ),
    [formatTooltipItem],
  );

  if (visibleSeries.length === 0 || xTime.length === 0 || maxValue <= 0) {
    return (
      <UsageEmptyState
        title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
        description={emptyDescription}
      />
    );
  }

  return (
    <div className="px-3 py-3">
      {showLegend ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2" role="list">
          {visibleSeries.map((item) => (
            <div
              key={item.key}
              className="flex min-w-0 items-center gap-2 text-ui-sm"
              role="listitem"
            >
              <span
                className="size-2 shrink-0 self-center rounded-full"
                style={{ backgroundColor: item.color }}
              />
              <span className="truncate text-foreground-subtle">{item.name}</span>
            </div>
          ))}
        </div>
      ) : null}
      <ChartContainer config={chartConfig} className="h-64 w-full">
        <LineChart accessibilityLayer data={chartData} margin={CODING_PLAN_LINE_CHART_MARGIN}>
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
          <YAxis hide domain={[0, maxValue]} />
          <ChartTooltip cursor={false} content={tooltipContent} />
          {visibleSeries.map((item) => (
            <Line
              key={item.key}
              dataKey={item.key}
              type="monotone"
              stroke={`var(--color-${item.key})`}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      </ChartContainer>
    </div>
  );
}
