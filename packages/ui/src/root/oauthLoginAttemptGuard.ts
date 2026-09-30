/**
 * A late failure arriving on another path is ignored once the same login attempt has already
 * succeeded or is finishing its success callback.
 */
export function shouldApplyOAuthPollingFailure(
  loginSucceeded: boolean,
  loginSuccessInFlight = false,
): boolean {
  return !loginSucceeded && !loginSuccessInFlight;
}
