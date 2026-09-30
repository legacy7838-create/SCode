/**
 * The supply gate for the Resume callback in the session context.
 *
 * Pressing Resume really starts an engine, so when the rollout does not hit, no path to starting an
 * engine may be left open. The tool card footer (the create-workflow renderer) and the turn-tail
 * digest card (ConversationWorkflowDigests) both gate their buttons on "is the callback present",
 * so cutting supply at the single session-context point makes both buttons disappear together — the
 * rollout flag does not have to be threaded into each leaf component. The run detail panel goes
 * through its own sendCommand and has an equivalent gate.
 *
 * Read-only sessions (shared read-only timelines) never provided Resume in the first place, and
 * that rule is unchanged.
 *
 * Runs that already exist keep rendering as usual: cards, digests, the run panel, and the artifacts
 * are all still there, they are just not clickable.
 */
export function resolveWorkflowResumeHandler<THandler>(options: {
  readOnly: boolean | undefined;
  /** Pass false while the rollout snapshot is not ready: unknown means not offered (fail-closed). */
  dynamicWorkflowEnabled: boolean;
  handler: THandler;
}): THandler | undefined {
  if (options.readOnly === true) return undefined;
  if (!options.dynamicWorkflowEnabled) return undefined;
  return options.handler;
}
