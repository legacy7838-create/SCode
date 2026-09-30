/**
 * The **implementation** of the `chart` preset renderer (recharts lives in this module, and only
 * here).
 *
 * Do not import it statically from the index: at module initialization recharts triggers
 * decimal.js-light's LN10 check, which in an Electron Linux container can block the whole renderer
 * from starting (the same fix recorded in `AppUsagePanel.tsx`). The public entry point is
 * `ArtifactChart.tsx`, which uses `lazy()` to push this module past the first paint.
 *
 * Two shapes:
 * - `compact`: the **axis-less sparkline + latest value** in the run side-pane card;
 * - full size: the axis-bearing chart + legend + reference lines + tooltip in the
 *   `workflow-artifact` tab.
 */

import { memo, useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  Scatter,
  XAxis,
  YAxis,
  type DotItemDotProps,
} from "recharts";
import {
  applyArtifactItems,
  type ArtifactItem,
  type ChartModel,
} from "@/app-shell/workflow-artifacts/presets/apply.js";
import {
  artifactSeriesColorVar,
  artifactSeriesDash,
  artifactSeriesSymbol,
  ARTIFACT_CHART_MAX_SERIES,
} from "@/app-shell/workflow-artifacts/presets/palette.js";
import {
  fieldHeading,
  PresetEmpty,
  PresetHeading,
  REVEAL_ANIMATION_CLASS,
  type PresetLabels,
} from "@/app-shell/workflow-artifacts/presets/parts.js";
import type { ChartSpec } from "@/app-shell/workflow-artifacts/presets/spec.js";
import { cn } from "@/components/lib/utils.js";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart.js";

/**
 * Above this many points, stop drawing the points: a line crammed with dots is harder to read than
 * one with no dots.
 */
const MAX_VISIBLE_DOTS = 60;
const FULL_MARGIN = { top: 8, right: 16, bottom: 0, left: 0 } as const;
const COMPACT_MARGIN = { top: 4, right: 4, bottom: 4, left: 4 } as const;

/**
 * Reveal of new points: the React key is the entry's `sequence` (stable), so only the points that
 * **newly mount on this frame** play the animation; existing points keep the same DOM node and do
 * not replay. Under `motion-reduce` the `animate-none` in the class name switches it off outright.
 */
function renderRevealDot(props: DotItemDotProps) {
  const { cx, cy, payload, stroke, index } = props;
  if (typeof cx !== "number" || typeof cy !== "number") {
    return null;
  }
  const sequence =
    payload && typeof payload === "object" && typeof payload.sequence === "number"
      ? payload.sequence
      : index;
  return (
    <circle
      className={REVEAL_ANIMATION_CLASS}
      cx={cx}
      cy={cy}
      fill={stroke}
      key={`reveal-${sequence}`}
      r={4}
    />
  );
}

function buildChartConfig(model: ChartModel): ChartConfig {
  return model.series.reduce<ChartConfig>((config, series) => {
    config[series.key] = {
      label: series.label,
      color: artifactSeriesColorVar(series.colorIndex),
    };
    return config;
  }, {});
}

function seriesMarks(model: ChartModel, showDots: boolean) {
  return model.series.map((series) => {
    const color = `var(--color-${series.key})`;
    if (model.type === "bar") {
      return <Bar dataKey={series.key} fill={color} key={series.key} isAnimationActive={false} />;
    }
    if (model.type === "scatter") {
      return (
        <Scatter
          dataKey={series.key}
          fill={color}
          isAnimationActive={false}
          key={series.key}
          // The dot pattern is a secondary code (a second identity clue besides color) on a scatter plot, the same as the line pattern of a polyline.
          shape={artifactSeriesSymbol(series.colorIndex)}
        />
      );
    }
    return (
      <Line
        connectNulls={false}
        dataKey={series.key}
        dot={showDots ? renderRevealDot : false}
        // recharts' own entry animation will redraw the **entire line** every time the data changes; in the real-time growth chart
        // That is, every time a point comes, the entire line flashes. Turn it off here, revealing that the animation is only handled by the new point's CSS.
        isAnimationActive={false}
        key={series.key}
        stroke={color}
        strokeDasharray={artifactSeriesDash(series.colorIndex)}
        strokeWidth={2}
        type="monotone"
      />
    );
  });
}

/**
 * The actual chart body, `memo`ized with a custom comparison: it **re-renders only when the point
 * count, the domain, or the series composition changes**.
 *
 * The reason is the first-paint freeze that portfolio fixed — recharts mirrors props into an
 * internal store inside an effect, and when the parent hands over a fresh data reference on every
 * render, that mirror chain is amplified into hundreds or thousands of pointless updates. Entries
 * are only ever appended, so "point count + first and last sequence + domain" is enough to tell
 * whether the data really changed.
 */
type PlotProps = { model: ChartModel; compact: boolean };

/**
 * The comparison predicate for `memo` (`true` = skip the re-render). It is exported separately so
 * it can be tested directly — "when does it not repaint" is itself this chart's performance
 * contract, and hiding it inside memo's second argument would leave it unpinnable.
 */
export function chartPlotPropsEqual(previous: PlotProps, next: PlotProps): boolean {
  if (previous.compact !== next.compact) {
    return false;
  }
  const a = previous.model;
  const b = next.model;
  if (a.type !== b.type || a.scale !== b.scale || a.x.numeric !== b.x.numeric) {
    return false;
  }
  if (a.series.length !== b.series.length) {
    return false;
  }
  if (a.series.some((series, index) => series.label !== b.series[index]?.label)) {
    return false;
  }
  if (a.points.length !== b.points.length) {
    return false;
  }
  // Head and tail sequence: It can also be recognized when the points have not changed but the entire batch of entries has been replaced (cold recovery and retrieval).
  if (a.points[0]?.sequence !== b.points[0]?.sequence) {
    return false;
  }
  if (a.points.at(-1)?.sequence !== b.points.at(-1)?.sequence) {
    return false;
  }
  if (a.baseline?.value !== b.baseline?.value) {
    return false;
  }
  return (
    a.domain?.xMin === b.domain?.xMin &&
    a.domain?.xMax === b.domain?.xMax &&
    a.domain?.yMin === b.domain?.yMin &&
    a.domain?.yMax === b.domain?.yMax
  );
}

const ArtifactChartPlot = memo(function ArtifactChartPlot({ model, compact }: PlotProps) {
  const config = useMemo(() => buildChartConfig(model), [model]);
  const showDots = model.points.length <= MAX_VISIBLE_DOTS;
  // Only the numerical value x is equipped with the value axis; bar is naturally a categorical comparison, and it always takes the categorical axis (band scale has the correct column width).
  const categoricalX = model.type === "bar" || !model.x.numeric;
  const logDomain: [number, number] | undefined =
    model.scale === "log" && model.domain ? [model.domain.yMin, model.domain.yMax] : undefined;

  if (compact) {
    return (
      <ChartContainer className="h-14 w-full" config={config}>
        <ComposedChart data={model.points} margin={COMPACT_MARGIN}>
          <XAxis
            dataKey={categoricalX ? "xLabel" : "x"}
            hide
            type={categoricalX ? "category" : "number"}
          />
          <YAxis hide {...(logDomain ? { domain: logDomain, scale: "log" as const } : {})} />
          {seriesMarks(model, showDots && model.points.length <= 24)}
        </ComposedChart>
      </ChartContainer>
    );
  }

  return (
    <ChartContainer className="h-56 w-full" config={config}>
      <ComposedChart data={model.points} margin={FULL_MARGIN}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          axisLine={false}
          dataKey={categoricalX ? "xLabel" : "x"}
          minTickGap={16}
          tickLine={false}
          tickMargin={8}
          type={categoricalX ? "category" : "number"}
          {...(categoricalX ? {} : { domain: ["dataMin", "dataMax"] as [string, string] })}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tickMargin={4}
          width={44}
          {...(logDomain ? { domain: logDomain, scale: "log" as const } : {})}
        />
        {model.baseline ? (
          <ReferenceLine
            label={{
              fill: "var(--color-foreground-subtle)",
              fontSize: 10,
              position: "insideTopRight",
              value: model.baseline.label,
            }}
            stroke="var(--color-foreground-subtlest)"
            strokeDasharray="4 4"
            y={model.baseline.value}
          />
        ) : null}
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_label, payload) => {
                const point = payload?.[0]?.payload as { xLabel?: string } | undefined;
                return fieldHeading(point?.xLabel ?? "", model.x.unit);
              }}
            />
          }
          cursor={false}
        />
        {seriesMarks(model, showDots)}
      </ComposedChart>
    </ChartContainer>
  );
}, chartPlotPropsEqual);

/**
 * The legend. **Always present (≥1 series)**, and each entry carries its own line style and latest
 * value on top of its color — identity is never carried by color alone (see the passage in
 * palette.ts about color slots not being pairwise distinguishable under color-vision deficiency).
 */
function ChartLegendRow({ model }: { model: ChartModel }) {
  const latest = model.points.at(-1);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" role="list">
      {model.series.map((series) => {
        const value = latest?.[series.key];
        return (
          <span
            className="flex min-w-0 items-center gap-1.5 text-ui-sm"
            data-testid="artifact-chart-legend-item"
            key={series.key}
            role="listitem"
          >
            <svg aria-hidden="true" className="shrink-0" height={8} width={16}>
              <line
                stroke={artifactSeriesColorVar(series.colorIndex)}
                strokeDasharray={artifactSeriesDash(series.colorIndex)}
                strokeWidth={2}
                x1={0}
                x2={16}
                y1={4}
                y2={4}
              />
            </svg>
            <span className="truncate text-foreground-subtle">{series.label}</span>
            {typeof value === "number" ? (
              // Directly mark the latest value: the legend is not just a color block + name, it is also the reading of this sequence at this moment.
              <span className="shrink-0 font-mono text-ui-xs text-foreground tabular-nums">
                {series.unit ? `${value} ${series.unit}` : String(value)}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/**
 * The "latest value" on the right in `compact` shape — the sparkline carries no axes of its own, so
 * the numbers have to be accounted for here.
 */
function CompactLatestValue({ model }: { model: ChartModel }) {
  const series = model.series[0];
  const latest = model.points.at(-1);
  const value = series && latest ? latest[series.key] : undefined;
  if (typeof value !== "number") {
    return null;
  }
  return (
    <span className="flex shrink-0 items-baseline gap-1" data-testid="artifact-chart-latest">
      <span
        className={cn(
          "font-mono text-ui-base font-medium text-foreground tabular-nums",
          REVEAL_ANIMATION_CLASS,
        )}
        key={`latest-${latest?.sequence ?? "none"}`}
      >
        {value}
      </span>
      {series?.unit ? (
        <span className="text-ui-xs text-foreground-subtle">{series.unit}</span>
      ) : null}
    </span>
  );
}

export function ArtifactChartView({
  spec,
  items,
  compact = false,
  labels,
  className,
}: {
  spec: ChartSpec;
  items: readonly ArtifactItem[];
  compact?: boolean;
  labels: PresetLabels;
  className?: string;
}) {
  const model = useMemo(() => {
    const built = applyArtifactItems("chart", spec, items);
    // There are only 6 color slots, and the extra sequences are not drawn - recycling colors will make the two sequences look exactly the same.
    return built.series.length > ARTIFACT_CHART_MAX_SERIES
      ? { ...built, series: built.series.slice(0, ARTIFACT_CHART_MAX_SERIES) }
      : built;
  }, [spec, items]);

  if (model.points.length === 0) {
    return (
      <div className={className}>
        {compact ? null : (
          <PresetHeading className="mb-3" description={spec.description} title={spec.title} />
        )}
        <PresetEmpty compact={compact} label={labels.empty} />
      </div>
    );
  }

  if (compact) {
    return (
      <div
        className={cn("flex min-w-0 items-center gap-2", className)}
        data-testid="artifact-chart-compact"
      >
        <div className="min-w-0 flex-1">
          <ArtifactChartPlot compact model={model} />
        </div>
        <CompactLatestValue model={model} />
      </div>
    );
  }

  return (
    <div className={cn("min-w-0", className)} data-testid="artifact-chart">
      <PresetHeading className="mb-2" description={spec.description} title={spec.title} />
      <div className="mb-2">
        <ChartLegendRow model={model} />
      </div>
      <ArtifactChartPlot compact={false} model={model} />
      <div className="mt-1 text-center text-ui-xs text-foreground-subtlest">
        {fieldHeading(model.x.label, model.x.unit)}
      </div>
    </div>
  );
}

export default ArtifactChartView;
