/**
 * Series palette and **secondary encoding** for the preset charts.
 *
 * The colors reuse the design system's existing `--color-usage-chart-1..6` (DESIGN.md "Color Usage
 * Rules": use semantic tokens, never invent one-off color values). These tokens are defined in all
 * four themes (light / dark / zai-light / zai-dark), so charts follow the theme automatically and
 * the components need no theme branching at all.
 *
 * **Why every series also carries a dash style**: these 6 color slots are not pairwise
 * distinguishable under color vision deficiency (protan / deutan) — feeding them to the dataviz
 * palette validation script, the violet↔blue and orange↔red pairs fall below the ΔE 8 threshold in
 * the all-pairs check. The only legitimate way out the validation script offers for that case is
 * "pair it with a secondary encoding": so here every series carries a fixed line style in addition
 * to its color, the legend and direct labels are always present, and identity is never borne by
 * color alone (the same spirit as DESIGN.md's "Use semantic status colors together with readable
 * text, never by color alone"). The palette itself is a repo-level asset.
 */

/**
 * Number of color slots = how many series a single chart can draw; extra y fields are not drawn
 * (better to draw less than cycle the colors).
 */
export const ARTIFACT_CHART_MAX_SERIES = 6;

/**
 * The color of the index-th series (a CSS variable reference, so it takes effect immediately on a
 * theme switch).
 */
export function artifactSeriesColorVar(index: number): string {
  return `var(--color-usage-chart-${(index % ARTIFACT_CHART_MAX_SERIES) + 1})`;
}

const SERIES_DASH: readonly (string | undefined)[] = [
  undefined,
  "6 3",
  "2 3",
  "9 3 2 3",
  "1 3",
  "12 4",
];

/** The line style of the index-th series; the first one is solid. */
export function artifactSeriesDash(index: number): string | undefined {
  return SERIES_DASH[index % SERIES_DASH.length];
}

const SERIES_SYMBOL = ["circle", "cross", "diamond", "square", "triangle", "star"] as const;

/**
 * The marker shape for scatter plots; like line styles, it is a second identity cue beyond color.
 */
export function artifactSeriesSymbol(index: number): (typeof SERIES_SYMBOL)[number] {
  return SERIES_SYMBOL[index % SERIES_SYMBOL.length]!;
}
