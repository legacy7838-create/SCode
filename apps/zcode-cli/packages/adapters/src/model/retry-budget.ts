import { ModelRetryBudget } from "@zcode/contracts";

/**
 * Classification of the retry budget tiers.
 *
 * "Unbounded" **only** relaxes the give-up condition for transient failures: the runner's attempt
 * loop and the two "can we try again after a failure" gates;
 * the backoff curve (2s→60s, jitter, Retry-After priority), the classification in
 * `isRetryableFailure`, no retry after `emittedRetryBoundaryEvent`, and the empty-completion retry
 * and compact paths are all left untouched.
 */

/** In status events `maxAttempts` is the sentinel for "unbounded" (Infinity is not serializable, 0 consumes no valid count). */
export const UNBOUNDED_RETRY_MAX_ATTEMPTS = 0;

export function isUnboundedRetryBudget(budget: ModelRetryBudget | undefined): boolean {
  return budget === ModelRetryBudget.Unbounded;
}

/** Is one more retry still allowed after a failure (equivalent to the existing `retryBudgetAttempt < maxAttempts`, always true when unbounded). */
export function retryBudgetAllows(
  budget: ModelRetryBudget | undefined,
  retryBudgetAttempt: number,
  maxAttempts: number,
): boolean {
  return isUnboundedRetryBudget(budget) || retryBudgetAttempt < maxAttempts;
}

/** The continuation condition of the attempt loop (equivalent to the existing `attempt <= loopMaxAttempts`, always true when unbounded). */
export function retryAttemptLoopContinues(
  budget: ModelRetryBudget | undefined,
  attempt: number,
  loopMaxAttempts: number,
): boolean {
  return isUnboundedRetryBudget(budget) || attempt <= loopMaxAttempts;
}

/** The maxAttempts written into status events / logs: the sentinel 0 when unbounded. */
export function retryBudgetMaxAttempts(
  budget: ModelRetryBudget | undefined,
  maxAttempts: number,
): number {
  return isUnboundedRetryBudget(budget) ? UNBOUNDED_RETRY_MAX_ATTEMPTS : maxAttempts;
}
