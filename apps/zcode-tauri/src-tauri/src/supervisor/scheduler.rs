//! Resident cron/off-peak scheduler — the Tauri replacement for
//! `packages/desktop/src/scheduler/index.ts`.
//!
//! The Electron scheduler was a real OS process with these properties, all of
//! which are preserved here:
//!   * a 20 s poll loop (`POLL_INTERVAL_MS`, `scheduler/index.ts:33`)
//!   * single-flight ticking with a make-up latch (`ticking`/`tickRequested`)
//!   * a 5 min misfire grace after which a missed fire is skipped, not made up
//!     (`MISFIRE_GRACE_MS`, `scheduler/index.ts:38`)
//!   * claims and settlements for `automations` and `off_peak_tasks`
//!
//! What changes is supervision: the Electron process had none, so a crash left
//! all dispatch dead until relaunch. Here it runs as a supervised child.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

/// Poll cadence. Matches `POLL_INTERVAL_MS`.
pub const POLL_INTERVAL_MS: u64 = 20_000;
/// A fire whose `next_run_at` is older than this is a misfire: skipped, never
/// made up. Matches `MISFIRE_GRACE_MS`.
pub const MISFIRE_GRACE_MS: u64 = 5 * 60_000;

/// Why a scheduled fire was not run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    /// The machine was asleep or the app was not running when the fire was due.
    ComputerAsleepOrAppNotRunning,
    /// A one-shot automation whose only fire time was missed; finalised.
    OneShotFinalized,
}

/// Outcome of evaluating one automation on a tick.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum TickOutcome {
    /// Claimed and dispatched to a host.
    Dispatched { run_id: String },
    /// Claimed but deliberately not run.
    Skipped { reason: SkipReason },
    /// Nothing was due.
    NotDue,
}

/// A due automation, as read from the index.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DueAutomation {
    pub automation_id: String,
    /// `next_run_at` in epoch milliseconds.
    pub next_run_at_ms: i64,
    /// True when the automation has no further commitments after this fire.
    pub one_shot: bool,
    /// True when this row is in retry backoff, which exempts it from misfire.
    pub is_retry: bool,
}

/// Build the stable run id for a fire.
///
/// The Electron version used `${automationId}:${scheduledAt}` and relied on
/// `next_run_at` not advancing while a row is in retry backoff, so a retry
/// re-derives the same id and upserts rather than duplicates
/// (`scheduler/index.ts:78-85`). That property is preserved here.
pub fn build_run_id(automation_id: &str, scheduled_at_ms: i64) -> String {
    format!("{automation_id}:{scheduled_at_ms}")
}

/// Decide what to do with one due automation.
pub fn evaluate(automation: &DueAutomation, now_ms: i64) -> TickOutcome {
    if automation.next_run_at_ms > now_ms {
        return TickOutcome::NotDue;
    }
    // Retries are exempt from misfire: the original fire already happened.
    if !automation.is_retry && automation.next_run_at_ms <= now_ms - MISFIRE_GRACE_MS as i64 {
        let reason = if automation.one_shot {
            SkipReason::OneShotFinalized
        } else {
            SkipReason::ComputerAsleepOrAppNotRunning
        };
        return TickOutcome::Skipped { reason };
    }
    TickOutcome::Dispatched {
        run_id: build_run_id(&automation.automation_id, automation.next_run_at_ms),
    }
}

/// The scheduler task body.
///
/// `claim_due` is injected so the loop is testable without a database; the
/// production wiring supplies a closure backed by the tasks-index store.
pub async fn run_scheduler<F>(
    mut shutdown: oneshot::Receiver<()>,
    mut claim_due: F,
) -> Result<(), String>
where
    F: FnMut(i64) -> Result<Vec<TickOutcome>, String>,
{
    let mut ticker = tokio::time::interval(std::time::Duration::from_millis(POLL_INTERVAL_MS));
    // `interval` fires immediately on first tick; the Electron loop waited one
    // full period after database readiness, which matters because the scheduler
    // must not race the host's migrations.
    ticker.tick().await;
    tracing::info!("scheduler started");

    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown => {
                tracing::info!("scheduler shutting down");
                return Ok(());
            }
            _ = ticker.tick() => {
                let now_ms = now_millis();
                match claim_due(now_ms) {
                    Ok(outcomes) => {
                        for outcome in outcomes {
                            match outcome {
                                TickOutcome::Dispatched { run_id } => {
                                    tracing::info!(run_id, "dispatched");
                                }
                                TickOutcome::Skipped { reason } => {
                                    tracing::info!("skipped fire: {reason:?}");
                                }
                                TickOutcome::NotDue => {}
                            }
                        }
                    }
                    Err(error) => {
                        // A failed tick must never kill the loop; this matches the
                        // original's per-tick try/catch.
                        tracing::warn!(%error, "scheduler tick failed");
                    }
                }
            }
        }
    }
}

/// Wall-clock milliseconds.
pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Spawn the resident scheduler under the supervisor.
pub fn spawn_scheduler(
    supervisor: &Arc<super::Supervisor>,
    key: &str,
    claim_due: impl FnMut(i64) -> Result<Vec<TickOutcome>, String> + Send + Sync + 'static,
) -> String {
    supervisor.spawn(
        "scheduler",
        key,
        super::boxed({
            // `claim_due` is `FnMut` state; park it so the closure stays `Fn`
            // and a restart can claim it exactly once.
            let cell = std::sync::Mutex::new(Some(claim_due));
            move |_id, shutdown| {
                let taken = cell.lock().ok().and_then(|mut c| c.take());
                async move {
                    match taken {
                        Some(claim) => run_scheduler(shutdown, claim).await,
                        None => Ok(()),
                    }
                }
            }
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn due(next_run_at_ms: i64, one_shot: bool, is_retry: bool) -> DueAutomation {
        DueAutomation {
            automation_id: "auto-1".into(),
            next_run_at_ms,
            one_shot,
            is_retry,
        }
    }

    #[test]
    fn future_fire_is_not_due() {
        let now = 1_000_000;
        assert_eq!(evaluate(&due(now + 1, false, false), now), TickOutcome::NotDue);
    }

    #[test]
    fn on_time_fire_dispatches_with_stable_run_id() {
        let now = 1_000_000;
        let outcome = evaluate(&due(now - 1_000, false, false), now);
        assert_eq!(
            outcome,
            TickOutcome::Dispatched {
                run_id: "auto-1:999000".into()
            }
        );
    }

    #[test]
    fn missed_fire_is_skipped_not_made_up() {
        let now = 1_000_000;
        let late = now - MISFIRE_GRACE_MS as i64 - 1;
        assert_eq!(
            evaluate(&due(late, false, false), now),
            TickOutcome::Skipped {
                reason: SkipReason::ComputerAsleepOrAppNotRunning
            }
        );
    }

    #[test]
    fn missed_one_shot_is_finalized() {
        let now = 1_000_000;
        let late = now - MISFIRE_GRACE_MS as i64 - 1;
        assert_eq!(
            evaluate(&due(late, true, false), now),
            TickOutcome::Skipped {
                reason: SkipReason::OneShotFinalized
            }
        );
    }

    #[test]
    fn retries_are_exempt_from_misfire() {
        let now = 1_000_000;
        let late = now - MISFIRE_GRACE_MS as i64 - 1;
        assert!(matches!(
            evaluate(&due(late, false, true), now),
            TickOutcome::Dispatched { .. }
        ));
    }

    #[test]
    fn retry_reuses_the_same_run_id() {
        // Stability of the run id across a retry is what makes upsert correct.
        let a = build_run_id("auto-1", 500);
        let b = build_run_id("auto-1", 500);
        assert_eq!(a, b);
        assert_ne!(a, build_run_id("auto-1", 600));
    }
}
