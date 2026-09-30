/**
 * The `metrics` preset renderer: a row of tiles, each showing the value from the **last entry that
 * carries the field**.
 *
 * Two forms:
 * - `compact`: the tile row in the run side panel card, laid out horizontally, with values and
 *   labels only;
 * - full size: the grid in the `workflow-artifact` tab, with larger values and units.
 */

import { memo, useMemo } from "react";
import {
  applyArtifactItems,
  type ArtifactItem,
  type MetricTileModel,
} from "@/app-shell/workflow-artifacts/presets/apply.js";
import {
  PresetEmpty,
  PresetHeading,
  REVEAL_ANIMATION_CLASS,
  type PresetLabels,
} from "@/app-shell/workflow-artifacts/presets/parts.js";
import type { MetricsSpec } from "@/app-shell/workflow-artifacts/presets/spec.js";
import { cn } from "@/components/lib/utils.js";

/**
 * A tile that has no value yet. It uses a dash rather than 0 — "not measured" and "measured as 0"
 * are not the same thing.
 */
const EMPTY_VALUE = "—";

function MetricTile({ tile, compact }: { tile: MetricTileModel; compact: boolean }) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5",
        compact ? "" : "rounded-lg border border-border bg-surface px-3 py-2",
      )}
      data-testid="artifact-metric-tile"
      data-metric-field={tile.field}
    >
      <span
        className={cn("truncate text-foreground-subtlest", compact ? "text-ui-xs" : "text-ui-sm")}
        title={tile.label}
      >
        {tile.label}
      </span>
      <span className="flex min-w-0 items-baseline gap-1">
        {/*
            The key carries the sequence: when the value changes the tile remounts, so that refresh
            plays the reveal animation once; tiles whose value did not change keep the same DOM node
            and do not flash along with the others.
            */}
        <span
          className={cn(
            "truncate font-mono font-medium text-foreground tabular-nums",
            compact ? "text-ui-sm" : "text-ui-lg",
            REVEAL_ANIMATION_CLASS,
          )}
          key={`${tile.field}:${tile.sequence ?? "none"}`}
          data-testid="artifact-metric-value"
          title={tile.value ?? EMPTY_VALUE}
        >
          {tile.value ?? EMPTY_VALUE}
        </span>
        {tile.unit && tile.value !== undefined ? (
          <span
            className={cn("shrink-0 text-foreground-subtle", compact ? "text-ui-xs" : "text-ui-sm")}
          >
            {tile.unit}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export const ArtifactMetrics = memo(function ArtifactMetrics({
  spec,
  items,
  compact = false,
  labels,
  className,
}: {
  spec: MetricsSpec;
  items: readonly ArtifactItem[];
  compact?: boolean;
  labels: PresetLabels;
  className?: string;
}) {
  const model = useMemo(() => applyArtifactItems("metrics", spec, items), [spec, items]);
  const hasAnyValue = model.metrics.some((tile) => tile.value !== undefined);

  if (!hasAnyValue) {
    return (
      <div className={className}>
        {compact ? null : (
          <PresetHeading className="mb-3" description={spec.description} title={spec.title} />
        )}
        <PresetEmpty compact={compact} label={labels.empty} />
      </div>
    );
  }

  return (
    <div className={className} data-testid="artifact-metrics">
      {compact ? null : (
        <PresetHeading className="mb-3" description={spec.description} title={spec.title} />
      )}
      {/* In a narrow side panel (~372px) the tiles wrap instead of overflowing horizontally; at full size they spread to fill the width by content. */}
      <div
        className={cn(
          "grid gap-2",
          compact
            ? "grid-cols-[repeat(auto-fill,minmax(6rem,1fr))]"
            : "grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]",
        )}
      >
        {model.metrics.map((tile) => (
          <MetricTile compact={compact} key={tile.field} tile={tile} />
        ))}
      </div>
    </div>
  );
});
