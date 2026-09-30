/**
 * A type mirror + lenient parsing for preset artifacts (chart / table / metrics / board).
 *
 * The `artifact` here is the **user-facing** one: the board a script declares through
 * `artifact.chart(id, spec)` and feeds through `report(item, id)`; not the engine-internal
 * `RunSettlement.artifact` "top-level return value".
 *
 * **Why parse it again on the UI side.** The authoritative validation of a spec lives in the engine
 * (zod, an illegal shape fails the run outright), what lands in the journal is canonical JSON, and
 * by the time the v4 projection gets it to the renderer the type has degraded to `unknown`. What
 * the renderer receives may be: a legal spec written by a new CLI, a field-poor spec written by an
 * old CLI, or a truncated/tampered line. A renderer should not throw on any of these and blow up
 * the whole side pane — so this layer only makes **structural** judgements: if it can render, it
 * returns the normalized spec; if it cannot, it returns `undefined` (the caller falls back to a
 * "cannot render" card).
 *
 * Lenient = surplus keys are ignored as-is, broken optional fields are dropped, and only a missing
 * required field makes it unrenderable.
 */

/** Reads one value out of a report entry: a dot path inside the entry ("timing.after"). */
export type ArtifactField = {
  field: string;
  label?: string;
  unit?: string;
};

export type ArtifactChartType = "line" | "bar" | "scatter";
export type ArtifactChartScale = "linear" | "log";

const CHART_TYPES: readonly ArtifactChartType[] = ["line", "bar", "scatter"];
const CHART_SCALES: readonly ArtifactChartScale[] = ["linear", "log"];

/** The presentation fields shared by every preset spec (the facade's `ArtifactOptions`). */
type ArtifactPresetOptions = {
  title?: string;
  description?: string;
};

export type ChartSpec = ArtifactPresetOptions & {
  /** Defaults to "line". */
  type?: ArtifactChartType;
  x: ArtifactField;
  /** Several = several series. */
  y: ArtifactField | ArtifactField[];
  /** The y axis, defaults to "linear". */
  scale?: ArtifactChartScale;
  /** Drawn as a horizontal reference line, taken from the first entry **that carries the field**. */
  baseline?: ArtifactField;
};

export type TableSpec = ArtifactPresetOptions & {
  columns: ArtifactField[];
  /**
   * The row's identity field; a later entry with the same key replaces that row. Absent = append
   * only.
   */
  key?: string;
};

export type MetricsSpec = ArtifactPresetOptions & {
  /** Each tile shows the value from the **last entry that carries the field**. */
  metrics: ArtifactField[];
};

export type BoardSpec = ArtifactPresetOptions & {
  /** The card's identity field; a later entry with the same key moves / updates that card. */
  key: string;
  /** The field for the column a card sits in. */
  status: string;
  /** Column order. Entries whose status is not in the list land in the trailing "Other" column. */
  columns: string[];
  /** The card title field (defaults to key) and the extra fields shown on the card. */
  cardTitle?: string;
  detail?: ArtifactField[];
};

export type ArtifactPresetKind = "chart" | "table" | "metrics" | "board";
export type ArtifactPresetSpec = ChartSpec | TableSpec | MetricsSpec | BoardSpec;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string; every field path / column name in the spec must be one. */
function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * One `ArtifactField`. It can be just a string ("latencyMs") — script authors write it that way;
 * the facade type does not allow it, but the journal may still hold the old shape, so this catches
 * it on the way through.
 */
function parseField(value: unknown): ArtifactField | undefined {
  const shorthand = readNonEmptyString(value);
  if (shorthand) {
    return { field: shorthand };
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const field = readNonEmptyString(value.field);
  if (!field) {
    return undefined;
  }
  const label = readNonEmptyString(value.label);
  const unit = readNonEmptyString(value.unit);
  return { field, ...(label ? { label } : {}), ...(unit ? { unit } : {}) };
}

/**
 * A list of fields. Bad entries are dropped individually (lenient); only an all-empty result counts
 * as unrenderable.
 */
function parseFieldList(value: unknown): ArtifactField[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const fields = value
    .map(parseField)
    .filter((field): field is ArtifactField => field !== undefined);
  return fields.length > 0 ? fields : undefined;
}

function parseOptions(spec: Record<string, unknown>): ArtifactPresetOptions {
  const title = readNonEmptyString(spec.title);
  const description = readNonEmptyString(spec.description);
  return { ...(title ? { title } : {}), ...(description ? { description } : {}) };
}

function parseChartSpec(spec: Record<string, unknown>): ChartSpec | undefined {
  const x = parseField(spec.x);
  if (!x) {
    return undefined;
  }
  // Whether it is a single y or an array, it is normalized into an array: the downstream (apply/renderer) only recognizes one shape.
  // One less `Array.isArray` fork means one less chance of "single sequence graph missing rendering".
  const single = Array.isArray(spec.y) ? undefined : parseField(spec.y);
  const y = Array.isArray(spec.y) ? parseFieldList(spec.y) : single ? [single] : undefined;
  if (!y) {
    return undefined;
  }
  const type = CHART_TYPES.find((candidate) => candidate === spec.type) ?? "line";
  const scale = CHART_SCALES.find((candidate) => candidate === spec.scale) ?? "linear";
  const baseline = parseField(spec.baseline);
  return {
    ...parseOptions(spec),
    type,
    x,
    y,
    scale,
    ...(baseline ? { baseline } : {}),
  };
}

function parseTableSpec(spec: Record<string, unknown>): TableSpec | undefined {
  const columns = parseFieldList(spec.columns);
  if (!columns) {
    return undefined;
  }
  const key = readNonEmptyString(spec.key);
  return { ...parseOptions(spec), columns, ...(key ? { key } : {}) };
}

function parseMetricsSpec(spec: Record<string, unknown>): MetricsSpec | undefined {
  const metrics = parseFieldList(spec.metrics);
  if (!metrics) {
    return undefined;
  }
  return { ...parseOptions(spec), metrics };
}

function parseBoardSpec(spec: Record<string, unknown>): BoardSpec | undefined {
  const key = readNonEmptyString(spec.key);
  const status = readNonEmptyString(spec.status);
  if (!key || !status) {
    return undefined;
  }
  if (!Array.isArray(spec.columns)) {
    return undefined;
  }
  const columns = spec.columns
    .map(readNonEmptyString)
    .filter((column): column is string => column !== undefined);
  if (columns.length === 0) {
    return undefined;
  }
  const cardTitle = readNonEmptyString(spec.cardTitle);
  const detail = parseFieldList(spec.detail);
  return {
    ...parseOptions(spec),
    key,
    status,
    columns,
    ...(cardTitle ? { cardTitle } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Parses the `unknown` spec from the wire into a renderable shape; `undefined` = unrenderable.
 *
 * What is normalized here (so downstream does not have to guard again): `chart.y` is always an
 * array, `chart.type` / `chart.scale` always have a value, and empty strings / whitespace-only
 * strings always count as absent.
 */
export function parseArtifactPresetSpec(
  kind: ArtifactPresetKind,
  spec: unknown,
): ArtifactPresetSpec | undefined {
  if (!isRecord(spec)) {
    return undefined;
  }
  switch (kind) {
    case "chart":
      return parseChartSpec(spec);
    case "table":
      return parseTableSpec(spec);
    case "metrics":
      return parseMetricsSpec(spec);
    case "board":
      return parseBoardSpec(spec);
    default:
      return undefined;
  }
}

/**
 * How `chart.y` is read after normalization; a parsed spec is always an array, so this only narrows
 * the type.
 */
export function chartSeriesFields(spec: ChartSpec): ArtifactField[] {
  return Array.isArray(spec.y) ? spec.y : [spec.y];
}

/** The field's name in the UI: an explicit `label` wins, otherwise the dot path itself is used. */
export function artifactFieldLabel(field: ArtifactField): string {
  return field.label ?? field.field;
}
