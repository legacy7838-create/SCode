/**
 * Adaptive concurrency controller: a pure AIMD state machine on one provider key.
 *
 * Pure-package discipline: no clock reading, no I/O - `now` (ms since epoch) is always passed in
 * by the caller; this class only answers "what is the cap now, is admission allowed, and did this
 * signal change the cap". Who feeds the signals and who does the queueing (bootstrap's
 * process-level governor) all live outside the package.
 *
 * The unit of measurement is the **model request** (one attempt each): `inFlight` = admitted but
 * not yet released requests. There is no ask-level count - a subagent only ever has one request
 * in flight, so "≤ N requests" and "≤ N subagents running" are equivalent.
 *
 * Batch damping relies on the **epoch**: each admission records the epoch of the moment, and each
 * rate-limit verdict does epoch += 1. A 429 only judges the current cap if its request was issued
 * under that **current** cap (same epoch); a 429 from an old epoch judges a cap that has already
 * been cut, so it only clears the streak and refreshes the cooldown. Success works the same way:
 * only successes from the current epoch count toward the streak.
 *
 * The signal methods all return the list of cap changes this signal caused (usually 0 or 1 entry;
 * 2 when an idle reset is immediately followed by a rate-limit verdict), and the caller fans them
 * out verbatim as `concurrency-changed` events.
 */

import type { ConcurrencyChange, ConcurrencyChangeReason } from "./types.js";

/**
 * A rate limit means `cap = max(FLOOR, floor(cap × 0.75))` (the coefficient was changed from 0.5 to
 * 0.75): halving reacts far too violently to an overshoot of "only one or two" - the gate is
 * request-level, so one 429 says the cap is too high and rarely says it is twice too high.
 */
export const CONCURRENCY_DECREASE_FACTOR = 0.75;
/** The additive-increase step. */
export const CONCURRENCY_INCREASE_STEP = 1;
/**
 * The number K of consecutive successful model requests required per +1. There is only one tier.
 * That value dropped from 40 to 4: the cost of a failed probe is just one request hitting one 429
 * and then falling back to `lastGood` (a level already proven usable) - not worth trading 40
 * successes for one experiment.
 */
export const CONCURRENCY_INCREASE_AFTER_SUCCESSES = 4;
/** There is always at least one probe running. */
export const CONCURRENCY_FLOOR = 1;
/** After a key has been idle this long (with nothing in flight), forget the learned cap and return to the ceiling. */
export const CONCURRENCY_IDLE_RESET_MS = 300_000;

/** The rate-limit-class reasons that make the cap decrease. */
export type ConcurrencyThrottleReason = Extract<
  ConcurrencyChangeReason,
  "rate_limited" | "provider_overloaded" | "offpeak_queued"
>;

/** A read-only snapshot of the controller (for test assertions, and for the governor to project the run header's `concurrency`). */
export interface ConcurrencyControllerSnapshot {
  readonly key: string;
  readonly ceiling: number;
  readonly cap: number;
  /** The rate-limit verdict count; handed to the request at admission and brought back for comparison when the request ends. */
  readonly epoch: number;
  readonly inFlight: number;
  readonly waiters: number;
  readonly successStreak: number;
  readonly cooldownUntil?: number;
  readonly lastRequestAt?: number;
  readonly lastGood?: number;
  readonly lastBad?: number;
}

export class ConcurrencyController {
  private cap: number;
  private epoch = 0;
  private inFlight = 0;
  private waiters_ = 0;
  private successStreak = 0;
  private cooldownUntil?: number;
  private lastRequestAt?: number;
  private lastGood?: number;
  private lastBad?: number;

  /**
   * @param key provider key (`${providerId}/${modelId}`), used only to fill into change events - the
   *   controller itself is indifferent to it. It is a constructor parameter rather than an argument
   *   to every signal: one controller serves one key, so that is an identity, not a parameter.
   * @param ceiling the CPU-derived ceiling: both the initial value and the upper bound.
   */
  constructor(
    readonly key: string,
    readonly ceiling: number,
  ) {
    this.cap = ceiling;
  }

  snapshot(): ConcurrencyControllerSnapshot {
    return {
      key: this.key,
      ceiling: this.ceiling,
      cap: this.cap,
      epoch: this.epoch,
      inFlight: this.inFlight,
      waiters: this.waiters_,
      successStreak: this.successStreak,
      ...(this.cooldownUntil === undefined ? {} : { cooldownUntil: this.cooldownUntil }),
      ...(this.lastRequestAt === undefined ? {} : { lastRequestAt: this.lastRequestAt }),
      ...(this.lastGood === undefined ? {} : { lastGood: this.lastGood }),
      ...(this.lastBad === undefined ? {} : { lastBad: this.lastBad }),
    };
  }

  /**
   * The gate (the admission condition): fewer requests in flight than the cap, and not in a
   * Retry-After cooldown. A pure query that performs no idle reset - the caller (the governor) calls
   * {@link observe} first on the admission path (admission is itself a "signal": the first run after
   * an hour of idleness has to start from the ceiling right away).
   */
  canAdmit(now: number): boolean {
    return (
      this.inFlight < this.cap && (this.cooldownUntil === undefined || now >= this.cooldownUntil)
    );
  }

  /** A "null signal" that only performs the idle-reset check (used before admission and before an observer lets a request through). */
  observe(now: number): ConcurrencyChange[] {
    return this.idleReset(now);
  }

  /**
   * A request was admitted: `inFlight++`, refresh `lastRequestAt`, return the epoch it belongs to
   * (brought back when the request ends). No idle reset - the caller has already done it in
   * {@link observe}; doing it again here would mean an admission that observe just judged "not
   *   idle" could somehow have become idle.
   */
  admitted(now: number): number {
    this.lastRequestAt = now;
    this.inFlight += 1;
    return this.epoch;
  }

  /**
   * A request ended successfully: `inFlight--`; only a success from the **current epoch** makes
   * `successStreak++` - a success from an old epoch proves the load under the old cap after backoff
   * lowered it, not that the new cap may go higher. `successStreak ≥ K` **proves** the current cap
   * usable: `lastGood = max(lastGood, cap)` (only a completed streak can set lastGood; decreasing
   * the cap cannot). Then, if there is a waiter **and** `cap < ceiling` -> +1. With no waiter the
   * streak still accumulates but is not cashed in.
   */
  succeeded(now: number, epoch: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (epoch !== this.epoch) return changes;
    this.successStreak += 1;
    if (this.successStreak < CONCURRENCY_INCREASE_AFTER_SUCCESSES) return changes;
    // This level is proven usable by an entire streak - regardless of whether anyone is waiting to climb it at the moment.
    if (this.lastGood === undefined || this.cap > this.lastGood) this.lastGood = this.cap;
    if (this.waiters_ <= 0 || this.cap >= this.ceiling) return changes;
    const previous = this.cap;
    this.cap = Math.min(this.ceiling, previous + CONCURRENCY_INCREASE_STEP);
    this.successStreak = 0;
    changes.push(this.change(previous, "recovered"));
    return changes;
  }

  /**
   * Rate-limited / overloaded. Always `inFlight--`, clear the streak, and if a Retry-After is
   * present push the cooldown out to the later of the two.
   *
   * Only a 429 with `epoch === the current epoch` moves the cap: it belongs to a request issued under
   * the current cap and is therefore a verdict on that cap; a 429 from an old epoch is ignored (no
   * event emitted). For the current epoch there are two tiers: rate-limited while probing **above**
   * `lastGood` -> fall back to `lastGood` (recording `lastBad`, without the coefficient cut);
   * otherwise (`lastGood` absent or `cap ≤ lastGood`: the wall moved down) ->
   * `cap = max(FLOOR, floor(cap × 0.75))`, record `lastBad = the old cap`, and **clear** `lastGood`: it has just
   * been disproved, while the new cap has not been proven by any streak yet (decreasing the cap does not set
   * lastGood). After either tier, `epoch += 1` - even when the cap
   * is already at the floor and the number did not change, a new page is turned: the same batch of
   * requests may trigger only one verdict.
   */
  throttled(
    now: number,
    epoch: number,
    reason: ConcurrencyThrottleReason,
    retryAfterMs?: number,
  ): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.successStreak = 0;
    const cooldownMs = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : undefined;
    if (cooldownMs !== undefined) {
      this.cooldownUntil = Math.max(this.cooldownUntil ?? 0, now + cooldownMs);
    }
    if (epoch !== this.epoch) return changes;

    const previous = this.cap;
    if (this.lastGood !== undefined && this.cap > this.lastGood) {
      this.lastBad = this.cap;
      this.cap = this.lastGood;
    } else {
      this.cap = Math.max(CONCURRENCY_FLOOR, Math.floor(this.cap * CONCURRENCY_DECREASE_FACTOR));
      this.lastBad = previous;
      this.lastGood = undefined;
    }
    this.epoch += 1;
    // When the cap is already on the floor and there is no Retry-After, nothing changes and no event occurs; even if the current limiter with Retry-After is in place, the cap does not move.
    // Also let the run head know "cooling to...", so all with cooldownMs are sent.
    if (previous === this.cap && cooldownMs === undefined) return changes;
    changes.push(this.change(previous, reason, cooldownMs));
    return changes;
  }

  /** A transient but non-rate-limit failure (timeout / 5xx / network): `inFlight--`, clear the streak, cap unchanged. */
  failedTransient(now: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.successStreak = 0;
    return changes;
  }

  /** A request ends in permanent failure / cancellation, or a ticket only ever sees a release with no terminal event: only `inFlight--`. */
  ended(now: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    return changes;
  }

  /** The number of waiters the governor feeds in when the queue changes (cap is only added to when there is demand). */
  waiters(now: number, count: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.waiters_ = Math.max(0, count);
    return changes;
  }

  // ———————————————————————————————— Internal ——————————————————————————————

  /**
   * Idle reset: `now − lastRequestAt ≥ IDLE_RESET_MS` with nothing in flight -> the cap returns to
   * the ceiling, streak / cooldown / lastGood / lastBad are cleared, epoch += 1. It happens lazily
   * whenever any signal arrives (there is no timer).
   */
  private idleReset(now: number): ConcurrencyChange[] {
    if (
      this.lastRequestAt === undefined ||
      this.inFlight !== 0 ||
      now - this.lastRequestAt < CONCURRENCY_IDLE_RESET_MS
    ) {
      return [];
    }
    const previous = this.cap;
    // Idempotent: do nothing when already at the ceiling and the state is clean (otherwise turn the page for each idle signal epoch).
    if (
      previous === this.ceiling &&
      this.successStreak === 0 &&
      this.cooldownUntil === undefined &&
      this.lastGood === undefined &&
      this.lastBad === undefined
    ) {
      return [];
    }
    this.cap = this.ceiling;
    this.successStreak = 0;
    this.cooldownUntil = undefined;
    this.lastGood = undefined;
    this.lastBad = undefined;
    this.epoch += 1;
    // lastRequestAt Reserved: The signal that is still idle next time should not be "reset" again; at this time the status is already at the ceiling.
    return previous === this.cap ? [] : [this.change(previous, "idle_reset")];
  }

  private change(
    previous: number,
    reason: ConcurrencyChangeReason,
    cooldownMs?: number,
  ): ConcurrencyChange {
    return {
      key: this.key,
      previous,
      next: this.cap,
      reason,
      ...(this.lastGood === undefined ? {} : { lastGood: this.lastGood }),
      ...(this.lastBad === undefined ? {} : { lastBad: this.lastBad }),
      ...(cooldownMs === undefined ? {} : { cooldownMs }),
    };
  }
}
