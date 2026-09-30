/**
 * The **entry point** of the `chart` preset renderer: lazy loading plus local fault isolation —
 * this module never touches recharts itself.
 *
 * Why it must be lazy: at module-init time recharts triggers decimal.js-light's LN10 validation,
 * which blocks the entire renderer startup inside the Electron Linux container (that fix is
 * recorded in `AppUsagePanel.tsx`; the spec's "preset renderer" line also makes `lazy()` a hard
 * requirement). Hence:
 * - the drawing body lives in `ArtifactChartView.tsx` and is only ever reached through a `lazy()`
 *   dynamic import;
 * - recharts is not among this file's or `index.ts`'s static dependencies, so whoever imports them
 *   never pulls the chart code into the first screen.
 *
 * Callers may also bypass this layer, do their own `lazy(() => import(".../ArtifactChartView.js"))`
 * and own the Suspense / error boundary — this file is just the default wrapper for that wiring.
 */

import { lazy, Suspense } from "react";
import type { ArtifactItem } from "@/app-shell/workflow-artifacts/presets/apply.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/parts.js";
import type { ChartSpec } from "@/app-shell/workflow-artifacts/presets/spec.js";
import { cn } from "@/components/lib/utils.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";

const ArtifactChartView = lazy(
  () => import("@/app-shell/workflow-artifacts/presets/ArtifactChartView.js"),
);

/**
 * Placeholder while loading: it only holds space and stays quiet — a "Loading" line would just
 * flash for an instant in a 200ms lazy load.
 */
function ChartSkeleton({ compact }: { compact: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "w-full animate-pulse rounded-lg bg-surface motion-reduce:animate-none",
        compact ? "h-14" : "h-56",
      )}
      data-testid="artifact-chart-skeleton"
    />
  );
}

export function ArtifactChart({
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
  return (
    // When the chart collapses, only this part collapses, and the rest of the run side panel remains as usual - the product area is the delivery surface and should not be a single point of failure.
    <ScopedErrorBoundary
      resetKeys={[spec, compact]}
      scope="workflow-artifact-chart"
      variant={compact ? "compact" : "inline"}
    >
      <Suspense fallback={<ChartSkeleton compact={compact} />}>
        <ArtifactChartView
          className={className}
          compact={compact}
          items={items}
          labels={labels}
          spec={spec}
        />
      </Suspense>
    </ScopedErrorBoundary>
  );
}
