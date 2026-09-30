/**
 * Duration rendering for "worked for 1m 42s" (`chat.history.workedFor`), extracted from
 * `ConversationTurnGroup` so the workflow completion card's "time" cell and the collapsed
 * turn header label read identically: the same span must be written the same way in both.
 *
 * Rules: round to the nearest second, at least 1 second; only non-zero day / hour / minute /
 * second parts are written, **at most two of them** (`1h 3m`, no seconds); the unit sits
 * directly against the number.
 */
type FormatMessage = (descriptor: { id: string }) => string;

interface WorkDurationPart {
  value: number;
  /** Localized unit word (`m`). */
  unit: string;
}

const UNIT_IDS = {
  day: "chat.history.duration.day",
  hour: "chat.history.duration.hour",
  minute: "chat.history.duration.minute",
  second: "chat.history.duration.second",
} as const;

/** Split into `[{value, unit}]` for the places that lay the number and the unit out separately (the completion card's big numbers). */
export function workDurationParts(
  durationMs: number,
  formatMessage: FormatMessage,
): WorkDurationPart[] {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: WorkDurationPart[] = [];
  if (days > 0) parts.push({ value: days, unit: formatMessage({ id: UNIT_IDS.day }) });
  if (hours > 0) parts.push({ value: hours, unit: formatMessage({ id: UNIT_IDS.hour }) });
  if (minutes > 0) parts.push({ value: minutes, unit: formatMessage({ id: UNIT_IDS.minute }) });
  if (seconds > 0 || parts.length === 0) {
    parts.push({ value: seconds, unit: formatMessage({ id: UNIT_IDS.second }) });
  }
  return parts.slice(0, 2);
}
