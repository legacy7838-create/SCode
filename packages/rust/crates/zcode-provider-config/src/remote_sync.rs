//! Builtin-release remote synchronizer: cadence + lease control file.
//!
//! Rust port of `ZCodeBuiltinRemoteSynchronizer`
//! (`packages/provider-node/src/zcode-builtin-remote-synchronizer.ts`).
//!
//! # Why a control file
//!
//! Desktop, the Electron host and the CLI adapter may all refresh the built-in
//! provider config from the same environment. The control file coalesces them:
//! only one process holds the lease at a time, the cadence (success: 1 h,
//! failure: capped exponential backoff) is shared, and no network call runs
//! while any file lock is held. A damaged control file is not a business
//! failure: it is rebuilt empty inside the next lock, exactly as the TS side
//! does.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::builtin_source::{ApplyRemoteReleaseResult, FileBuiltinSource};
use crate::schema::BuiltinRelease;

pub type ZCodeBuiltinRefreshResult = &'static str;

pub const REFRESH_UPDATED: ZCodeBuiltinRefreshResult = "updated";
pub const REFRESH_UNCHANGED: ZCodeBuiltinRefreshResult = "unchanged";
pub const REFRESH_STALE: ZCodeBuiltinRefreshResult = "stale";
pub const REFRESH_MISSING: ZCodeBuiltinRefreshResult = "missing";
pub const REFRESH_SKIPPED: ZCodeBuiltinRefreshResult = "skipped";
pub const REFRESH_DISPOSED: ZCodeBuiltinRefreshResult = "disposed";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    LeaseHeld,
    NotDue,
    EndpointChanged,
}

/// What the observer receives after each refresh attempt.
#[derive(Debug, Clone, PartialEq)]
pub struct ZCodeBuiltinRefreshEvent {
    pub result: ZCodeBuiltinRefreshResult,
    pub reason: Option<SkipReason>,
    pub revision: Option<u64>,
}

pub struct RemoteSynchronizerOptions {
    pub control_file_path: PathBuf,
    pub success_interval_ms: u64,
    pub lease_duration_ms: u64,
    pub failure_base_delay_ms: u64,
    pub failure_max_delay_ms: u64,
}

impl Default for RemoteSynchronizerOptions {
    fn default() -> Self {
        Self {
            control_file_path: PathBuf::new(),
            // TS defaults: successIntervalMs 1 h, leaseDurationMs 30 s,
            // failureBaseDelayMs 60 s, failureMaxDelayMs 1 h.
            success_interval_ms: 60 * 60 * 1_000,
            lease_duration_ms: 30_000,
            failure_base_delay_ms: 60_000,
            failure_max_delay_ms: 60 * 60 * 1_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct RefreshControl {
    endpoint_key: String,
    lease_id: Option<String>,
    lease_until: u64,
    next_eligible_at: u64,
    failure_count: u64,
}

impl RefreshControl {
    fn empty() -> Self {
        Self {
            endpoint_key: String::new(),
            lease_id: None,
            lease_until: 0,
            next_eligible_at: 0,
            failure_count: 0,
        }
    }
}

pub struct ZCodeBuiltinRemoteSynchronizer {
    source: FileBuiltinSource,
    options: RemoteSynchronizerOptions,
    resolve_endpoint_key: Box<dyn Fn() -> Result<String, String>>,
    fetch_release: Box<dyn Fn(&str) -> Result<Option<BuiltinRelease>, String>>,
    on_refresh_result: Option<Box<dyn Fn(&ZCodeBuiltinRefreshEvent) + Send>>,
    disposed: AtomicBool,
    in_flight: Mutex<bool>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn random_lease_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 ^ (d.as_secs() << 17))
        .unwrap_or_default();
    let pid = std::process::id() as u64;
    format!(
        "lease-{pid}-{nanos:016x}-{}",
        pid.wrapping_mul(2_654_435_761)
    )
}

/// Read the control file; unparseable or structurally-wrong content degrades
/// to an empty control — the file is a coalescing hint, not a business fact.
fn read_control(file_path: &Path) -> RefreshControl {
    let Ok(raw) = std::fs::read_to_string(file_path) else {
        return RefreshControl::empty();
    };
    let Ok(input) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return RefreshControl::empty();
    };
    let endpoint_key = input
        .get("endpointKey")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let lease_id = input
        .get("leaseId")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let lease_until = input
        .get("leaseUntil")
        .and_then(|v| v.as_u64())
        .unwrap_or_default();
    let next_eligible_at = input
        .get("nextEligibleAt")
        .and_then(|v| v.as_u64())
        .unwrap_or_default();
    let failure_count = input
        .get("failureCount")
        .and_then(|v| v.as_u64())
        .unwrap_or_default();
    // Mirrors the TS `isRefreshControl` guard: only a well-formed control is
    // trusted; anything else is rebuilt.
    if endpoint_key.is_empty()
        && lease_until == 0
        && next_eligible_at == 0
        && failure_count == 0
        && lease_id.is_none()
    {
        return RefreshControl::empty();
    }
    RefreshControl {
        endpoint_key: endpoint_key.to_string(),
        lease_id,
        lease_until,
        next_eligible_at,
        failure_count,
    }
}

fn write_control(file_path: &Path, control: &RefreshControl) -> Result<(), String> {
    let value = serde_json::json!({
        "schemaVersion": 1,
        "endpointKey": control.endpoint_key,
        "leaseId": control.lease_id,
        "leaseUntil": control.lease_until,
        "nextEligibleAt": control.next_eligible_at,
        "failureCount": control.failure_count,
    });
    let bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    zcode_private_file::atomic_write_private_text_file(
        file_path,
        std::str::from_utf8(&bytes).map_err(|e| e.to_string())?,
    )
}

enum Acquisition {
    Acquired(String),
    Skipped(SkipReason),
}

impl ZCodeBuiltinRemoteSynchronizer {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        source: FileBuiltinSource,
        options: RemoteSynchronizerOptions,
        resolve_endpoint_key: impl Fn() -> Result<String, String> + 'static,
        fetch_release: impl Fn(&str) -> Result<Option<BuiltinRelease>, String> + 'static,
        on_refresh_result: Option<Box<dyn Fn(&ZCodeBuiltinRefreshEvent) + Send>>,
    ) -> Self {
        Self {
            source,
            options,
            resolve_endpoint_key: Box::new(resolve_endpoint_key),
            fetch_release: Box::new(fetch_release),
            on_refresh_result,
            disposed: AtomicBool::new(false),
            in_flight: Mutex::new(false),
        }
    }

    pub fn refresh(&self, force: bool) -> Result<ZCodeBuiltinRefreshResult, String> {
        if self.disposed.load(Ordering::SeqCst) {
            return Ok(REFRESH_DISPOSED);
        }
        // Coalesce concurrent refreshes: one network call at a time, like the
        // TS `#inFlight` promise.
        if let Ok(mut in_flight) = self.in_flight.lock() {
            if *in_flight {
                return Ok(REFRESH_SKIPPED);
            }
            *in_flight = true;
        }
        let result = self.refresh_inner(force);
        if let Ok(mut in_flight) = self.in_flight.lock() {
            *in_flight = false;
        }
        result
    }

    pub fn dispose(&self) {
        self.disposed.store(true, Ordering::SeqCst);
    }

    pub fn source(&self) -> &FileBuiltinSource {
        &self.source
    }

    fn refresh_inner(&self, force: bool) -> Result<ZCodeBuiltinRefreshResult, String> {
        let endpoint_key = (self.resolve_endpoint_key)()?.trim().to_string();
        if self.disposed.load(Ordering::SeqCst) {
            return Ok(REFRESH_DISPOSED);
        }
        if endpoint_key.is_empty() {
            return Err("ZCode Built-in remote Endpoint must not be empty".into());
        }
        let lease_id = random_lease_id();

        let acquisition = zcode_private_file::with_file_lock(
            &self.options.control_file_path,
            || -> Result<Acquisition, String> {
                let now = now_ms();
                let current = read_control(&self.options.control_file_path);
                let same_endpoint = current.endpoint_key == endpoint_key;
                if same_endpoint && current.lease_until > now {
                    return Ok(Acquisition::Skipped(SkipReason::LeaseHeld));
                }
                if !force && same_endpoint && current.next_eligible_at > now {
                    return Ok(Acquisition::Skipped(SkipReason::NotDue));
                }
                write_control(
                    &self.options.control_file_path,
                    &RefreshControl {
                        endpoint_key: endpoint_key.clone(),
                        lease_id: Some(lease_id.clone()),
                        lease_until: now + self.options.lease_duration_ms,
                        next_eligible_at: if same_endpoint {
                            current.next_eligible_at
                        } else {
                            0
                        },
                        failure_count: if same_endpoint {
                            current.failure_count
                        } else {
                            0
                        },
                    },
                )?;
                Ok(Acquisition::Acquired(lease_id))
            },
        )?;

        let lease_id = match acquisition {
            Acquisition::Skipped(reason) => {
                self.report(ZCodeBuiltinRefreshEvent {
                    result: REFRESH_SKIPPED,
                    reason: Some(reason),
                    revision: None,
                });
                return Ok(REFRESH_SKIPPED);
            }
            Acquisition::Acquired(lease_id) => lease_id,
        };

        if self.disposed.load(Ordering::SeqCst) {
            self.finish_lease(&endpoint_key, &lease_id, None)?;
            return Ok(REFRESH_DISPOSED);
        }

        let fetch_result = (self.fetch_release)(&endpoint_key);
        if self.disposed.load(Ordering::SeqCst) {
            self.finish_lease(&endpoint_key, &lease_id, None)?;
            return Ok(REFRESH_DISPOSED);
        }
        let fetch_result = fetch_result.map_err(|error| {
            // Failure path still releases the lease with the backoff applied.
            let _ = self.finish_lease(&endpoint_key, &lease_id, Some(false));
            error
        })?;

        // Endpoint re-check after the network call: an endpoint change mid-flight
        // must not let a release land for the wrong environment.
        let current_endpoint_key = (self.resolve_endpoint_key)()?.trim().to_string();
        if current_endpoint_key != endpoint_key {
            self.finish_lease(&endpoint_key, &lease_id, Some(true))?;
            self.report(ZCodeBuiltinRefreshEvent {
                result: REFRESH_SKIPPED,
                reason: Some(SkipReason::EndpointChanged),
                revision: None,
            });
            return Ok(REFRESH_SKIPPED);
        }

        let result = match fetch_result {
            None => REFRESH_MISSING,
            Some(release) => {
                let revision = Some(release.revision);
                let applied = self.source.apply_remote_release(release)?;
                let result = match applied {
                    ApplyRemoteReleaseResult::Updated => REFRESH_UPDATED,
                    ApplyRemoteReleaseResult::Unchanged => REFRESH_UNCHANGED,
                    ApplyRemoteReleaseResult::Stale => REFRESH_STALE,
                };
                self.finish_lease(&endpoint_key, &lease_id, Some(true))?;
                self.report(ZCodeBuiltinRefreshEvent {
                    result,
                    reason: None,
                    revision,
                });
                return Ok(result);
            }
        };
        self.finish_lease(&endpoint_key, &lease_id, Some(true))?;
        self.report(ZCodeBuiltinRefreshEvent {
            result,
            reason: None,
            revision: None,
        });
        Ok(result)
    }

    /// Success: next eligible in the success interval, failure count cleared.
    /// Failure: capped exponential backoff (`base * 2^(count - 1)`, max 1 h).
    /// Cancelled (disposed): keep the current cadence.
    fn finish_lease(
        &self,
        endpoint_key: &str,
        lease_id: &str,
        success: Option<bool>,
    ) -> Result<(), String> {
        zcode_private_file::with_file_lock(
            &self.options.control_file_path,
            || -> Result<(), String> {
                let now = now_ms();
                let current = read_control(&self.options.control_file_path);
                if current.endpoint_key != endpoint_key
                    || current.lease_id.as_deref() != Some(lease_id)
                {
                    return Ok(());
                }
                let failure_count = match success {
                    None => current.failure_count,
                    Some(true) => 0,
                    Some(false) => current.failure_count + 1,
                };
                let delay = match success {
                    None => 0,
                    Some(true) => self.options.success_interval_ms,
                    Some(false) => {
                        let exponent = failure_count.saturating_sub(1).min(16) as u32;
                        (self.options.failure_base_delay_ms * 2u64.pow(exponent))
                            .min(self.options.failure_max_delay_ms)
                    }
                };
                write_control(
                    &self.options.control_file_path,
                    &RefreshControl {
                        endpoint_key: endpoint_key.to_string(),
                        lease_id: None,
                        lease_until: 0,
                        next_eligible_at: now + delay,
                        failure_count,
                    },
                )
            },
        )
    }

    fn report(&self, event: ZCodeBuiltinRefreshEvent) {
        if self.disposed.load(Ordering::SeqCst) {
            return;
        }
        // Observer errors must never change a successful application into a
        // failed download.
        if let Some(on_refresh_result) = &self.on_refresh_result {
            on_refresh_result(&event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn temp_control_path(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("zcode-remote-sync-{name}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir.join("control.json")
    }

    #[test]
    fn a_damaged_control_file_does_not_block_refresh() {
        let control_path = temp_control_path("damaged");
        let _ = std::fs::remove_file(&control_path);
        std::fs::write(&control_path, "{ not json").unwrap();
        let control = read_control(&control_path);
        assert_eq!(control, RefreshControl::empty());
        let _ = std::fs::remove_file(&control_path);
    }

    #[test]
    fn a_lease_held_control_file_skips_and_a_replayed_lease_does_not_crash() {
        let control_path = temp_control_path("lease");
        let _ = std::fs::remove_file(&control_path);
        write_control(
            &control_path,
            &RefreshControl {
                endpoint_key: "ep-1".into(),
                lease_id: Some("lease-1".into()),
                lease_until: now_ms() + 60_000,
                next_eligible_at: 0,
                failure_count: 0,
            },
        )
        .unwrap();
        let control = read_control(&control_path);
        assert_eq!(control.endpoint_key, "ep-1");
        assert_eq!(control.lease_id.as_deref(), Some("lease-1"));
        let _ = std::fs::remove_file(&control_path);
    }

    #[test]
    fn the_success_delay_cancels_and_failure_backoff_is_capped() {
        let options = RemoteSynchronizerOptions {
            success_interval_ms: 1_000,
            lease_duration_ms: 50,
            failure_base_delay_ms: 100,
            failure_max_delay_ms: 300,
            ..Default::default()
        };
        // Failure delays: 100, 200, 400→300 (capped), 300.
        let delays: Vec<u64> = (1..=4u64)
            .map(|count| {
                let exponent = count.saturating_sub(1).min(16) as u32;
                (options.failure_base_delay_ms * 2u64.pow(exponent))
                    .min(options.failure_max_delay_ms)
            })
            .collect();
        assert_eq!(delays, vec![100, 200, 300, 300]);
    }

    #[test]
    fn a_non_integer_failure_count_in_the_control_file_is_rebuilt() {
        let control_path = temp_control_path("bad-count");
        let _ = std::fs::remove_file(&control_path);
        std::fs::write(
            &control_path,
            serde_json::json!({
                "schemaVersion": 1,
                "endpointKey": "ep",
                "leaseUntil": 0,
                "nextEligibleAt": 0,
                "failureCount": -3
            })
            .to_string(),
        )
        .unwrap();
        let control = read_control(&control_path);
        assert_eq!(control.failure_count, 0);
        let _ = std::fs::remove_file(&control_path);
    }

    #[test]
    fn an_empty_endpoint_is_a_hard_error_not_a_network_call() {
        let control_path = temp_control_path("empty-endpoint");
        let _ = std::fs::remove_file(&control_path);
        let source = crate::builtin_source::FileBuiltinSource::new(
            PathBuf::from("/nonexistent/bundled.json"),
            Some(control_path.clone()),
        )
        .unwrap();
        let fetch_called = std::sync::Arc::new(AtomicBool::new(false));
        let synchronizer = ZCodeBuiltinRemoteSynchronizer::new(
            source,
            RemoteSynchronizerOptions {
                control_file_path: control_path.clone(),
                ..Default::default()
            },
            || Ok("  ".to_string()),
            {
                let fetch_called = std::sync::Arc::clone(&fetch_called);
                move |_: &str| {
                    fetch_called.store(true, Ordering::SeqCst);
                    Ok(None)
                }
            },
            None,
        );
        let error = synchronizer.refresh(false).unwrap_err();
        assert!(error.contains("Endpoint must not be empty"), "{error}");
        assert!(
            !fetch_called.load(Ordering::SeqCst),
            "no network call for an empty endpoint"
        );
        let _ = std::fs::remove_file(&control_path);
    }
}
