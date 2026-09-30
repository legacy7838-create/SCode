/**
 * Number and time formatting for observation workflow tool cards (shared by GetWorkflowRun and
 * ListWorkflowRuns). Pure functions with no i18n dependency: numbers and times go through the
 * default Intl locale, and only the copy goes through the message table.
 */

export function formatWorkflowTokenCount(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) < 1_000) return String(Math.round(value));
  if (Math.abs(value) < 1_000_000) {
    return `${trimTrailingZero((value / 1_000).toFixed(1))}k`;
  }
  return `${trimTrailingZero((value / 1_000_000).toFixed(1))}M`;
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

const SHORT_TIMESTAMP_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * The short timestamp for list rows: in a dense list only the month, day, hour and minute are kept.
 */
export function formatWorkflowTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return String(epochMs);
  return SHORT_TIMESTAMP_FORMAT.format(new Date(epochMs));
}

const DURATION_MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;

function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * `40s` / `5m 10s` / `2h 15m` / `3d 2h`: how every duration segment and age is written in the
 * situation snapshot.
 *
 * Deliberately identical, character for character, with the model-side `formatWorkflowRunDuration`
 * of GetWorkflowRun (apps/zcode-cli/packages/core/src/tool/handlers/workflow-run-introspection.ts):
 * for the same number from the same snapshot, what the model reads and what the card draws must not
 * look different.
 */
export function formatWorkflowDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (total < DURATION_MS.minute) return `${Math.floor(total / DURATION_MS.second)}s`;
  if (total < DURATION_MS.hour) {
    const minutes = Math.floor(total / DURATION_MS.minute);
    return `${minutes}m ${padTwo(Math.floor((total % DURATION_MS.minute) / DURATION_MS.second))}s`;
  }
  if (total < DURATION_MS.day) {
    const hours = Math.floor(total / DURATION_MS.hour);
    return `${hours}h ${padTwo(Math.floor((total % DURATION_MS.hour) / DURATION_MS.minute))}m`;
  }
  const days = Math.floor(total / DURATION_MS.day);
  return `${days}d ${Math.floor((total % DURATION_MS.day) / DURATION_MS.hour)}h`;
}

/**
 * The bare duration behind “how long ago” (the “ago” in the copy is assembled by the message
 * table).
 *
 * The reference point is the snapshot time `generatedAt`, **not** `Date.now()`: when a transcript
 * from three days ago is reopened, the age on the card should still be the age it had at that
 * moment, otherwise the same card drifts on every re-render. With no reference point or without
 * that moment, return `undefined` — the read side then omits the whole age, and never substitutes 0
 * or “unknown” for something it does not know.
 */
export function formatWorkflowAge(
  generatedAt: number | undefined,
  at: number | undefined,
): string | undefined {
  if (generatedAt === undefined || at === undefined) return undefined;
  if (!Number.isFinite(generatedAt) || !Number.isFinite(at)) return undefined;
  return formatWorkflowDuration(generatedAt - at);
}
