/**
 * Pure display rules for pending questions (escalation Q&A).
 *
 * Split out of workflowRunPanel.ts (the eslint max-lines 400-line gate, the same precedent as
 * WorkflowRunSidePaneSections.tsx): that file already carries the detail page's four existing rule
 * sets (budget math, Cancel availability, result determination, event-line summaries), and
 * escalation Q&A is a new family of vocabulary — adding it there would push the file right over the
 * gate.
 */

const WAITED_MINUTE_MS = 60_000;
const WAITED_HOUR_MS = 60 * WAITED_MINUTE_MS;
const WAITED_DAY_MS = 24 * WAITED_HOUR_MS;

/**
 * The bit of intl capability this module needs, declared locally instead of borrowed from
 * workflowRunPanel.
 *
 * It is a structural type, so having each side declare its own copy cannot drift (the shape is
 * dictated by react-intl's formatMessage), while importing the type would trade that for a module
 * dependency nothing needs — avoiding exactly that dependency is the point of splitting the file.
 */
type FormatMessage = (descriptor: { id: string }, values?: Record<string, string>) => string;

/**
 * "How long has this question been waiting" — the first thing a reader asks on seeing a pending
 * question.
 *
 * A pure function, with `now` injected by the caller (the component feeds it fresh instants at a
 * fixed interval): a run that is waiting **precisely does not emit events**, so it cannot be
 * recomputed "as a side effect of the next projection update" — that would leave a question stuck
 * for half an hour showing as "just now".
 *
 * The wording reuses the existing `sidePane.time.*` family (already present in both languages)
 * rather than minting a new set of keys for the same meaning.
 *
 * Three edges are worth writing down:
 * - `askedAt` absent (events replayed from an old journal do not carry the field) → return
 *   undefined and render no label at all, instead of showing an invented "just now".
 * - Clock skew puts `askedAt` in the future (the ask instant is minted by the CLI process, which in
 *   a remote session is not even the same machine as the rendering process) → clamp to "just now".
 *   A negative duration is worse than showing nothing.
 * - The ladder stops at "days": a parked question may by design wait indefinitely (there is no
 *   timeout), so the upper bound needs a way to be expressed.
 */
export function workflowRunQuestionWaitedLabel(
  askedAt: number | undefined,
  now: number,
  formatMessage: FormatMessage,
): string | undefined {
  if (askedAt === undefined || !Number.isFinite(askedAt)) return undefined;
  const elapsed = now - askedAt;
  if (elapsed < WAITED_MINUTE_MS) return formatMessage({ id: "sidePane.time.justNow" });
  if (elapsed < WAITED_HOUR_MS) {
    return formatMessage(
      { id: "sidePane.time.minutesAgo" },
      { count: String(Math.floor(elapsed / WAITED_MINUTE_MS)) },
    );
  }
  if (elapsed < WAITED_DAY_MS) {
    return formatMessage(
      { id: "sidePane.time.hoursAgo" },
      { count: String(Math.floor(elapsed / WAITED_HOUR_MS)) },
    );
  }
  return formatMessage(
    { id: "sidePane.time.daysAgo" },
    { count: String(Math.floor(elapsed / WAITED_DAY_MS)) },
  );
}
