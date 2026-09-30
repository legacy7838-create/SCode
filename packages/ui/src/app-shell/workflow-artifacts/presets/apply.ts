/**
 * `applyArtifactItems` — folds a stream of `report(item, artifactId)` entries into the view model
 * of a preset dashboard.
 *
 * Pure and React-free: the dashboard itself stores **no data**; every dot / row / card is an entry
 * in the journal with `kind = "report"` whose `artifact_id` matches. Replaying the same entries
 * twice must produce the same chart, so nothing here may depend on time, randomness, or external
 * state; the collapsing rules are all decided by the spec.
 *
 * Entries are only ever **appended** (the journal is append-only), so all four collapse passes can
 * run in a single pass in arrival order.
 */

import {
  artifactFieldLabel,
  chartSeriesFields,
  type ArtifactChartScale,
  type ArtifactChartType,
  type ArtifactField,
  type ArtifactPresetKind,
  type ArtifactPresetSpec,
  type BoardSpec,
  type ChartSpec,
  type MetricsSpec,
  type TableSpec,
} from "@/app-shell/workflow-artifacts/presets/spec.js";

/**
 * One arriving entry. `sequence` is a run-global monotonically increasing event index — it is both
 * the React key (the new-dot reveal animation relies on it to tell "this dot is new") and the
 * cursor for incremental fetching; `siteId × ordinal` is the identity on the journal (the same key
 * idiom as the Results section), used for row/card identity when there is no spec key.
 */
export type ArtifactItem = {
  sequence: number;
  siteId: string;
  ordinal: number;
  item: unknown;
};

export type ChartSeriesModel = {
  /**
   * The recharts dataKey; it uses the sequence number rather than a field path, because a "."
   * inside a dot path would be read by recharts as nesting.
   */
  key: string;
  field: string;
  label: string;
  unit?: string;
  /** Palette slot (see seriesColorVar). */
  colorIndex: number;
};

export type ChartPointModel = Record<string, number | string | null> & {
  /** Stable React key: only new dots play the reveal animation, existing dots never replay. */
  sequence: number;
  /** Position on the x axis. When x is not numeric, the arrival sequence number is used. */
  x: number;
  /** Text shown on the x axis tick. */
  xLabel: string;
};

export type ChartModel = {
  kind: "chart";
  type: ArtifactChartType;
  scale: ArtifactChartScale;
  series: ChartSeriesModel[];
  points: ChartPointModel[];
  x: { label: string; unit?: string; numeric: boolean };
  /**
   * Reference line: taken from the first entry that carries the field. Non-positive reference lines
   * are dropped on a log axis as well.
   */
  baseline?: { value: number; label: string; unit?: string };
  /** Domain used for memo comparison; absent when there are no dots. */
  domain?: { xMin: number; xMax: number; yMin: number; yMax: number };
};

type TableColumnModel = { field: string; label: string; unit?: string };
type TableRowModel = { id: string; sequence: number; cells: string[] };
type TableModel = {
  kind: "table";
  columns: TableColumnModel[];
  rows: TableRowModel[];
};

export type MetricTileModel = {
  field: string;
  label: string;
  unit?: string;
  /** Value from the last entry that carries the field; absent if it never appeared. */
  value?: string;
  raw?: unknown;
  /** Which entry the value came from — the animation key when the tile refreshes. */
  sequence?: number;
};
type MetricsModel = { kind: "metrics"; metrics: MetricTileModel[] };

export type BoardCardModel = {
  id: string;
  sequence: number;
  title: string;
  status: string;
  details: { label: string; value: string; unit?: string }[];
};
export type BoardColumnModel = {
  id: string;
  /**
   * The "Other" column has no name from the spec, so the renderer fills the label in via
   * labels.otherColumn.
   */
  other: boolean;
  cards: BoardCardModel[];
};
type BoardModel = {
  kind: "board";
  columns: BoardColumnModel[];
  cardCount: number;
};

type ArtifactPresetModel = ChartModel | TableModel | MetricsModel | BoardModel;

/**
 * Id of the column that falls into the trailing "Other" column; if the spec's columns really do
 * contain a column of the same name it merges with it — acceptable.
 */
const BOARD_OTHER_COLUMN_ID = "__other__";

/**
 * Dot path read: "timing.after", "rounds.0.ms". Array indices are treated as numeric fields; a path
 * that does not resolve returns `undefined` (= this entry has no such field).
 */
function readArtifactField(item: unknown, path: string): unknown {
  const segments = path.split(".");
  let cursor: unknown = item;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) {
      return undefined;
    }
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        return undefined;
      }
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * "Does this entry carry this field". Both `undefined` and `null` count as not carrying it: if the
 * metrics' "last entry carrying the field" counted explicit null too, a single reset would pin the
 * tile to the empty value.
 */
function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * Numeric coercion: real numbers are used as-is, and numeric strings are accepted too (values that
 * scripts scrape out of command output are often strings).
 */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Display text for cell / card details. Objects go through compact JSON — far more useful than
 * "[object Object]".
 */
function formatArtifactValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // Circular references, etc.: It is better to display a placeholder than to have the entire table throw an exception.
    return String(value);
  }
}

function seriesKey(index: number): string {
  return `y${index}`;
}

function applyChart(spec: ChartSpec, items: readonly ArtifactItem[]): ChartModel {
  const fields = chartSeriesFields(spec);
  const series: ChartSeriesModel[] = fields.map((field, index) => ({
    key: seriesKey(index),
    field: field.field,
    label: artifactFieldLabel(field),
    ...(field.unit ? { unit: field.unit } : {}),
    colorIndex: index,
  }));

  type Raw = { sequence: number; x: unknown; values: (number | undefined)[] };
  const raws: Raw[] = [];
  let baseline: ChartModel["baseline"];

  for (const entry of items) {
    const rawX = readArtifactField(entry.item, spec.x.field);
    if (!hasValue(rawX)) {
      // An entry with neither x has nowhere to place on the graph; it is silently skipped (it is still visible in the Results area).
      continue;
    }
    const values = fields.map((field) => {
      const value = toFiniteNumber(readArtifactField(entry.item, field.field));
      if (value === undefined) {
        return undefined;
      }
      // Non-positive numbers have no position on the log axis - drop this dimension of the point, rather than the entire sequence or graph.
      return spec.scale === "log" && value <= 0 ? undefined : value;
    });
    raws.push({ sequence: entry.sequence, x: rawX, values });

    if (spec.baseline && !baseline) {
      const raw = readArtifactField(entry.item, spec.baseline.field);
      const value = toFiniteNumber(raw);
      if (value !== undefined && !(spec.scale === "log" && value <= 0)) {
        baseline = {
          value,
          label: artifactFieldLabel(spec.baseline),
          ...(spec.baseline.unit ? { unit: spec.baseline.unit } : {}),
        };
      }
    }
  }

  // The values ​​x are sorted. Mixing a non-numeric value will degenerate the entire axis into "arrival order" - a semi-sorted x-axis is more deceptive than an unsorted x-axis.
  const numericX = raws.length > 0 && raws.every((raw) => toFiniteNumber(raw.x) !== undefined);
  const ordered = numericX
    ? [...raws].sort((left, right) => {
        const delta = toFiniteNumber(left.x)! - toFiniteNumber(right.x)!;
        // At the same time, x is pressed in order of arrival, ensuring that the same batch of entries is folded in the same order each time.
        return delta !== 0 ? delta : left.sequence - right.sequence;
      })
    : raws;

  const points: ChartPointModel[] = ordered.map((raw, index) => {
    const x = numericX ? toFiniteNumber(raw.x)! : index;
    const point: ChartPointModel = {
      sequence: raw.sequence,
      x,
      xLabel: formatArtifactValue(raw.x),
    };
    raw.values.forEach((value, seriesIndex) => {
      point[seriesKey(seriesIndex)] = value ?? null;
    });
    return point;
  });

  const yValues = ordered.flatMap((raw) =>
    raw.values.filter((value): value is number => value !== undefined),
  );
  const domain =
    points.length > 0 && yValues.length > 0
      ? {
          xMin: Math.min(...points.map((point) => point.x)),
          xMax: Math.max(...points.map((point) => point.x)),
          yMin: Math.min(...yValues),
          yMax: Math.max(...yValues),
        }
      : undefined;

  return {
    kind: "chart",
    type: spec.type ?? "line",
    scale: spec.scale ?? "linear",
    series,
    points,
    x: {
      label: artifactFieldLabel(spec.x),
      ...(spec.x.unit ? { unit: spec.x.unit } : {}),
      numeric: numericX,
    },
    ...(baseline ? { baseline } : {}),
    ...(domain ? { domain } : {}),
  };
}

function applyTable(spec: TableSpec, items: readonly ArtifactItem[]): TableModel {
  const columns: TableColumnModel[] = spec.columns.map((column) => ({
    field: column.field,
    label: artifactFieldLabel(column),
    ...(column.unit ? { unit: column.unit } : {}),
  }));

  // key present = upsert: later entries replace the entire line, but the line remains where it first appeared -
  // A table that jumps into sort cannot be read at runtime.
  const byId = new Map<string, TableRowModel>();
  for (const entry of items) {
    const keyValue = spec.key ? readArtifactField(entry.item, spec.key) : undefined;
    // When the key is absent (or the key is declared but not included), use the journal identity: `siteId@ordinal` to be unique one by one.
    // So upsert naturally degenerates into append - there is no need to write a path for each mode.
    const id = hasValue(keyValue)
      ? formatArtifactValue(keyValue)
      : `${entry.siteId}@${entry.ordinal}`;
    byId.set(id, {
      id,
      sequence: entry.sequence,
      cells: columns.map((column) =>
        formatArtifactValue(readArtifactField(entry.item, column.field)),
      ),
    });
  }

  return { kind: "table", columns, rows: [...byId.values()] };
}

function applyMetrics(spec: MetricsSpec, items: readonly ArtifactItem[]): MetricsModel {
  const metrics: MetricTileModel[] = spec.metrics.map((metric) => ({
    field: metric.field,
    label: artifactFieldLabel(metric),
    ...(metric.unit ? { unit: metric.unit } : {}),
  }));

  // Each tile finds its own "last entry with this field" - not the "last entry".
  // A heartbeat entry that only reports stage should not erase the previous round of p99 to empty.
  for (const entry of items) {
    metrics.forEach((tile, index) => {
      const raw = readArtifactField(entry.item, tile.field);
      if (!hasValue(raw)) {
        return;
      }
      metrics[index] = {
        ...tile,
        value: formatArtifactValue(raw),
        raw,
        sequence: entry.sequence,
      };
    });
  }

  return { kind: "metrics", metrics };
}

function applyBoard(spec: BoardSpec, items: readonly ArtifactItem[]): BoardModel {
  const detail: ArtifactField[] = spec.detail ?? [];
  // The insertion order of the Map = the order in which the cards first appear; cards that change status are still arranged in this order in the new column.
  const byId = new Map<string, BoardCardModel>();

  for (const entry of items) {
    const keyValue = readArtifactField(entry.item, spec.key);
    if (!hasValue(keyValue)) {
      // Items without identity have nowhere to place on the board (the entire meaning of the board is "press key upsert").
      continue;
    }
    const id = formatArtifactValue(keyValue);
    const status = formatArtifactValue(readArtifactField(entry.item, spec.status));
    const titleRaw = spec.cardTitle ? readArtifactField(entry.item, spec.cardTitle) : undefined;
    byId.set(id, {
      id,
      sequence: entry.sequence,
      title: hasValue(titleRaw) ? formatArtifactValue(titleRaw) : id,
      status,
      details: detail.map((field) => ({
        label: artifactFieldLabel(field),
        value: formatArtifactValue(readArtifactField(entry.item, field.field)),
        ...(field.unit ? { unit: field.unit } : {}),
      })),
    });
  }

  const columns: BoardColumnModel[] = spec.columns.map((column) => ({
    id: column,
    other: false,
    cards: [],
  }));
  const listed = new Map(columns.map((column) => [column.id, column]));
  const other: BoardColumnModel = { id: BOARD_OTHER_COLUMN_ID, other: true, cards: [] };

  for (const card of byId.values()) {
    (listed.get(card.status) ?? other).cards.push(card);
  }

  return {
    kind: "board",
    // "Other" is always at the end, and only appears when there is a card - an empty column will make the already narrow side panel even more crowded.
    columns: other.cards.length > 0 ? [...columns, other] : columns,
    cardCount: byId.size,
  };
}

export function applyArtifactItems(
  kind: "chart",
  spec: ChartSpec,
  items: readonly ArtifactItem[],
): ChartModel;
export function applyArtifactItems(
  kind: "table",
  spec: TableSpec,
  items: readonly ArtifactItem[],
): TableModel;
export function applyArtifactItems(
  kind: "metrics",
  spec: MetricsSpec,
  items: readonly ArtifactItem[],
): MetricsModel;
export function applyArtifactItems(
  kind: "board",
  spec: BoardSpec,
  items: readonly ArtifactItem[],
): BoardModel;
export function applyArtifactItems(
  kind: ArtifactPresetKind,
  spec: ArtifactPresetSpec,
  items: readonly ArtifactItem[],
): ArtifactPresetModel;
export function applyArtifactItems(
  kind: ArtifactPresetKind,
  spec: ArtifactPresetSpec,
  items: readonly ArtifactItem[],
): ArtifactPresetModel {
  switch (kind) {
    case "chart":
      return applyChart(spec as ChartSpec, items);
    case "table":
      return applyTable(spec as TableSpec, items);
    case "metrics":
      return applyMetrics(spec as MetricsSpec, items);
    case "board":
      return applyBoard(spec as BoardSpec, items);
  }
}
