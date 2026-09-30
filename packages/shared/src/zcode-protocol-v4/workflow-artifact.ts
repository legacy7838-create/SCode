/**
 * Any **script value** inside a workflow run (an artifact returned at the top level, a
 * `report(item)` entry) → the text shown to a model or reader. Rules: a string passes through;
 * everything else goes through `JSON.stringify(v, null, 2)`; when stringify returns undefined or
 * throws, fall back to `String(v)`; `undefined` returns `undefined` (the caller then leaves the
 * whole field absent).
 *
 * It lived in contracts (dynamic-workflow-run.port.ts) because its three cross-package consumers
 * at the time — the completion notification's `<result>` / `<reports>` (core), the `resultText`
 * on runtime task entries (core, the only source for TaskOutput), and
 * `workflowRuns.reports[].preview` (v4 projection, the line in the detail page's Results section)
 * — must all produce byte-identical text. It moved here once a fourth consumer appeared: the
 * reduction of `reports[].preview` sank into this package along with the shared reducer
 * (workflow-runs-reducer.ts), and the dependency direction is contracts → shared, so this
 * package cannot import contracts. contracts keeps a re-export in place, and no core-side
 * consumer changes.
 *
 * For the same reason there is no length cap here: the notification side truncates at 120k, the
 * TaskOutput side has an artifact budget, and the projection side has `maxReportPreviewLength`
 * — each bound belongs to its own boundary.
 *
 * The artifact shape is unconstrained — records, arrays, strings, numbers, and null are all
 * legal, so there is no `isRecord` gate here (the original implementation read the legacy
 * `Workflow`'s `output.response`, which is exactly what caused that desktop-observed bug).
 */
export function serializeWorkflowArtifact(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    // JSON.stringify returns undefined for undefined / function / symbol, and throws an error for circular references——
    // In both cases, fall back to String(value), never discarding the entire value.
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}
