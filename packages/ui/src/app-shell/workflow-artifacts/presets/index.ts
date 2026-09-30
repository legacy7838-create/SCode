/**
 * The public surface of the preset artifact renderers.
 *
 * Four renderers plus two pure-function layers:
 * - `parseArtifactPresetSpec(kind, spec)` decides whether an `unknown` spec arriving over the wire
 *   is renderable or not;
 * - `applyArtifactItems(kind, spec, items)` folds the `report(item, id)` item stream into a view
 *   model;
 * - `<ArtifactChart|Table|Metrics|Board>` renders it, and `compact` is the small-size form used in
 *   run side pane cards.
 *
 * **This barrel has no static dependency on recharts**: `ArtifactChart` is a `lazy()` wrapper (see
 * `ArtifactChart.tsx`), so importing this module does not pull the charting library into the first
 * screen.
 */

export { type ArtifactItem } from "@/app-shell/workflow-artifacts/presets/apply.js";
export {
  parseArtifactPresetSpec,
  type ArtifactPresetKind,
  type BoardSpec,
  type ChartSpec,
  type MetricsSpec,
  type TableSpec,
} from "@/app-shell/workflow-artifacts/presets/spec.js";

export { type PresetLabels } from "@/app-shell/workflow-artifacts/presets/parts.js";
export { ArtifactChart } from "@/app-shell/workflow-artifacts/presets/ArtifactChart.js";
export { ArtifactTable } from "@/app-shell/workflow-artifacts/presets/ArtifactTable.js";
export { ArtifactMetrics } from "@/app-shell/workflow-artifacts/presets/ArtifactMetrics.js";
export { ArtifactBoard } from "@/app-shell/workflow-artifacts/presets/ArtifactBoard.js";
