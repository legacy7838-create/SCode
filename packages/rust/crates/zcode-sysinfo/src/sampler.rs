//! Per-process CPU accounting: the cputime-delta sampler.
//!
//! Replaces `createProcessResourceSampler`
//! (`packages/services/src/process/processResourceSampler.ts:282-351`). The baseline
//! map moves into Rust so a sample round is one async task and one FFI crossing
//! instead of a table read across the boundary followed by the accounting going back.
//!
//! Every rule below is a port, not a redesign:
//!
//! | rule | predecessor |
//! | --- | --- |
//! | first sample has no delta baseline, so `cpuPercent = 0` | `:303-305` |
//! | a baseline is reusable only when pid, command and cputime still agree | `:307-311` |
//! | percentage is machine-wide: `Δcputime / Δwallclock × 100 / logicalCpuCount` | `:313-315` |
//! | clamp to `[0, 100]`, round to one decimal | `:322`, `:353-355` |
//! | a baseline unseen for 60 s is dropped | `:328-333`, `:21` |

use std::collections::HashMap;

use crate::table::ResourceRow;

/// A baseline older than this is discarded, so a recycled pid is never compared
/// against a process that no longer exists. Mirrors `CPU_BASELINE_TTL_MS`
/// (`processResourceSampler.ts:21`).
pub const CPU_BASELINE_TTL_MS: f64 = 60_000.0;

/// One sampled process, as it crosses into TypeScript.
///
/// The JS key names are produced by napi's `snake_case → camelCase` mapping, so
/// `rss_kb` arrives as `rssKb` and `cpu_percent` as `cpuPercent` — the exact keys the
/// deleted `ProcessResourceSample` (`processResourceSampler.ts:266-272`) emitted.
#[derive(Debug, Clone, PartialEq)]
pub struct ProcessResourceSample {
    pub pid: u32,
    pub ppid: u32,
    pub rss_kb: u64,
    pub cpu_percent: f64,
    pub command: String,
}

#[derive(Debug, Clone)]
struct Baseline {
    cpu_time_ms: u64,
    at_ms: f64,
    command: String,
}

/// The stateful half of the sampler: one instance per Host process.
#[derive(Debug, Default)]
pub struct SamplerState {
    baselines: HashMap<u32, Baseline>,
    logical_cpu_count: f64,
}

impl SamplerState {

    /// `logical_cpu_count` is the number of logical cores, i.e. what `os.cpus().length`
    /// returned. It is supplied by the caller (never read from the platform here) so
    /// the divisor is exactly the one the predecessor used, and so a test can pin it.
    ///
    /// Mirrors `Math.max(1, …)` (`processResourceSampler.ts:286`) **including its NaN
    /// behaviour**: JavaScript's `Math.max(1, NaN)` is `NaN`, which makes every
    /// percentage `NaN` and therefore zero after `roundPercent`. Clamping NaN to 1
    /// here would have reported 100% for a saturated core — recorded as F16 in the
    /// spec's differential, and caught by replaying the legacy sampler.
    pub fn new(logical_cpu_count: f64) -> Self {
        Self {
            baselines: HashMap::new(),
            logical_cpu_count: if logical_cpu_count.is_nan() {
                f64::NAN
            } else {
                logical_cpu_count.max(1.0)
            },
        }
    }

    /// Turns one table read into one sample set.
    ///
    /// `now_ms` is `Date.now()` supplied by the TypeScript wrapper, for the same
    /// reason `zcode-cron` keeps the clock host-side: two callers in one process must
    /// not be able to disagree about the wall clock (invariant 4's "the host is the
    /// host").
    pub fn sample(&mut self, rows: Vec<ResourceRow>, now_ms: f64) -> Vec<ProcessResourceSample> {
        let at = now_ms;
        let mut samples = Vec::with_capacity(rows.len());

        for row in rows {
            let cpu_percent = match self.baselines.get(&row.pid) {
                // PID-reuse protection: a different command, a cputime that went
                // backwards, or two samples inside the same millisecond all mean the
                // pid is not the process we last saw, so the baseline is re-established
                // and the round reports 0.
                Some(baseline)
                    if baseline.command == row.command
                        && row.cpu_time_ms >= baseline.cpu_time_ms
                        && at > baseline.at_ms =>
                {
                    let elapsed_ms = at - baseline.at_ms;
                    let delta_ms = row.cpu_time_ms - baseline.cpu_time_ms;
                    round_percent((delta_ms as f64 / elapsed_ms) * 100.0 / self.logical_cpu_count)
                }
                _ => 0.0,
            };

            self.baselines.insert(
                row.pid,
                Baseline {
                    cpu_time_ms: row.cpu_time_ms,
                    at_ms: at,
                    command: row.command.clone(),
                },
            );

            samples.push(ProcessResourceSample {
                pid: row.pid,
                ppid: row.ppid,
                rss_kb: row.rss_kb,
                cpu_percent: cpu_percent.clamp(0.0, 100.0),
                command: row.command,
            });
        }

        self.evict_stale_baselines(&samples, at);
        samples
    }

    fn evict_stale_baselines(&mut self, samples: &[ProcessResourceSample], at: f64) {
        let seen: std::collections::HashSet<u32> = samples.iter().map(|s| s.pid).collect();
        self.baselines.retain(|pid, baseline| {
            seen.contains(pid) || at - baseline.at_ms <= CPU_BASELINE_TTL_MS
        });
    }
}

/// Mirrors `roundPercent` (`processResourceSampler.ts:353-355`):
/// `Number.isFinite(value) ? Math.round(value * 10) / 10 : 0`.
///
/// `cpu_percent` is never negative here — the delta is guarded to be non-negative and
/// the divisor is at least 1 — so Rust's round-half-away-from-zero and JavaScript's
/// round-half-up agree on every reachable value.
fn round_percent(value: f64) -> f64 {
    if value.is_finite() {
        (value * 10.0).round() / 10.0
    } else {
        0.0
    }
}
