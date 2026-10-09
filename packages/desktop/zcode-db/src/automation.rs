//! AutomationRepo pure helpers (slice 21). The domain row→`ZCodeAutomation` projection depends on
//! the shared `modelSelectionSchema`/cron subsystem and is a later slice; these backoff / stale-claim
//! computations are self-contained and correctness-critical, so they land first with tests.

/// Mirrors TS `DISPATCH_RETRY_BASE_MS`.
pub const DISPATCH_RETRY_BASE_MS: i64 = 30_000;
/// Mirrors TS `DISPATCH_RETRY_CAP_MS` (15 min).
pub const DISPATCH_RETRY_CAP_MS: i64 = 15 * 60_000;
/// Mirrors TS `CLAIM_STALE_MS` (10 min).
pub const CLAIM_STALE_MS: i64 = 10 * 60_000;

/// Port of `computeRetryAt`: exponential backoff `base * 2**max(0, attempts-1)` capped at
/// `DISPATCH_RETRY_CAP_MS`, added to `now`. The shift is clamped so a large `attempts` can't
/// overflow before the cap is applied (once `base << k` exceeds the cap it stays capped).
pub fn compute_retry_at(now: i64, attempts: i64) -> i64 {
    let exponent = (attempts - 1).max(0);
    let backoff = if exponent >= 16 {
        DISPATCH_RETRY_CAP_MS
    } else {
        (DISPATCH_RETRY_BASE_MS << exponent).min(DISPATCH_RETRY_CAP_MS)
    };
    now + backoff
}

/// The `stale` threshold param the claim/collect queries bind (`now - CLAIM_STALE_MS`).
pub fn claim_stale_threshold(now: i64) -> i64 {
    now - CLAIM_STALE_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_backoff_doubles_then_caps() {
        assert_eq!(
            compute_retry_at(1000, 0),
            1000 + 30_000,
            "attempts<=1 → base"
        );
        assert_eq!(compute_retry_at(1000, 1), 1000 + 30_000);
        assert_eq!(compute_retry_at(0, 2), 60_000);
        assert_eq!(compute_retry_at(0, 3), 120_000);
        assert_eq!(compute_retry_at(0, 4), 240_000);
        assert_eq!(compute_retry_at(0, 5), 480_000);
        // 30_000 * 2^5 = 960_000 > cap → 900_000.
        assert_eq!(compute_retry_at(0, 6), DISPATCH_RETRY_CAP_MS);
        // A huge attempt count stays capped (no overflow).
        assert_eq!(compute_retry_at(0, 60), DISPATCH_RETRY_CAP_MS);
    }

    #[test]
    fn stale_threshold_subtracts_ten_minutes() {
        assert_eq!(claim_stale_threshold(1_000_000), 1_000_000 - CLAIM_STALE_MS);
    }
}
