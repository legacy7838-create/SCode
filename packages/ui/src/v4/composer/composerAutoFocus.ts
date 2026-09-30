/**
 * The composer auto-focus decision (a pure function, free of React/DOM so it is easy to unit test).
 *
 * Starting a new task (startDraft increments draftFocusVersion), switching conversations (a
 * sessionId→scope change) and mounting all request that the cursor be handed back to the input, but
 * whether focus actually happens depends on three states:
 * - `skip`: not enabled (a pane split off into the background, autoFocusEnabled=false) or a mobile
 *   viewport (auto-focus pops up the soft keyboard, which is disruptive) — no focus, and the intent
 *   is not stashed either.
 * - `defer`: enabled but the composer is temporarily not editable (briefly disabled when switching
 *   to a connecting conversation) — the focus intent is stashed and redeemed once, after
 *   disabled→false makes it editable again.
 * - `focus-now`: enabled and editable, so focus immediately.
 */
type ComposerAutoFocusDecision = "focus-now" | "defer" | "skip";

export interface ComposerAutoFocusOptions {
  /** Host gate (SessionPane.focused): only the focused pane auto-focuses. */
  autoFocusEnabled: boolean;
  /** Whether the composer is not editable (v4: sessionId is connecting). */
  disabled: boolean;
  /** Whether this is a mobile text-input viewport. */
  isMobileViewport: boolean;
}

export function resolveComposerAutoFocus({
  autoFocusEnabled,
  disabled,
  isMobileViewport,
}: ComposerAutoFocusOptions): ComposerAutoFocusDecision {
  if (!autoFocusEnabled || isMobileViewport) return "skip";
  if (disabled) return "defer";
  return "focus-now";
}
