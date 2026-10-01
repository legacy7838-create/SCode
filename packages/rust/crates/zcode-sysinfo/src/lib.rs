//! `zcode-sysinfo` — host and process introspection.
//!
//! Spec: `docs/specs/rust-native-sysinfo.md`
//!
//! Replaces, in `packages/services/src/process/processResourceSampler.ts`:
//!   * `createProcessResourceTableReader` (`:188-267`) — the machine-wide process
//!     table, including the `ps` and `powershell.exe` child-process spawns it
//!     performed on macOS and Windows (invariant 5);
//!   * `parseLinuxProcStat` (`:117-149`) and `parseLinuxVmRssKb` (`:151-154`);
//!   * the `ps`/CIM text parsers (`:77-96`, `:98-113`, `:154-176`), which are deleted
//!     rather than ported because the spawns they parsed are gone (invariant 2);
//!   * `createProcessResourceSampler` (`:282-351`) — the cputime-delta accounting.
//!
//! Porting risk: the emitted field names, units and null-vs-absent semantics are a
//! wire contract shared with `@zcode/shared`'s `HostResourceUsageProcess` and the
//! resource-manager window, and the CPU percentages are read live, so a wrong
//! rounding or a swapped field is invisible until the UI shows it. The differential
//! in spec §5 is the gate; the fixture corpus in `tests/` is the durable half.
//!
//! Invariant protected: **10** (measure before binding). This is the only surface in
//! the host-introspection directories that clears the 0.095 µs FFI floor — 7.303 ms
//! of work for 313 PIDs, measured, against 1.20 ms here. The other 25 runnable
//! functions in `packages/services/src/{system,process}/` are below or beside the
//! floor and are listed with their measurements in spec §2.
//!
//! **Invariant 4**: the sample round is a napi `AsyncTask` and never a synchronous
//! call on the Host event loop. The cancel flag is cleared on the JS thread before
//! the task is handed to the threadpool, so a `cancel()` issued after `sample()`
//! returns is always observed by that round (invariant 6).

pub mod linux;
pub mod sampler;
pub mod table;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{AsyncTask, Task};
use napi_derive::napi;

pub use sampler::{ProcessResourceSample, SamplerState, CPU_BASELINE_TTL_MS};
pub use table::{read_table, ResourceRow};

/// One process sampled by the resource manager.
///
/// The TypeScript wrapper receives exactly the keys the deleted
/// `ProcessResourceSample` (`processResourceSampler.ts:266-272`) emitted. napi maps
/// the Rust snake_case names to the same camelCase keys the legacy object had.
#[napi(object)]
pub struct NativeProcessResourceSample {
    pub pid: u32,
    pub ppid: u32,
    /// Resident set size, kilobytes. napi 3 has no `u64` binding, so this is an
    /// `i64`; it still arrives in JS as a plain `number`, and a process cannot reach
    /// 2^53 kB, so the value is exact.
    pub rss_kb: i64,
    /// Machine-wide normalised percentage; 100 means every logical core is saturated.
    /// Rounded to one decimal.
    pub cpu_percent: f64,
    /// Command name or executable path, as the platform reports it.
    pub command: String,
}

impl From<ProcessResourceSample> for NativeProcessResourceSample {
    fn from(sample: ProcessResourceSample) -> Self {
        Self {
            pid: sample.pid,
            ppid: sample.ppid,
            rss_kb: sample.rss_kb as i64,
            cpu_percent: sample.cpu_percent,
            command: sample.command,
        }
    }
}

/// The stateful resource sampler. One instance per Host process; the cputime
/// baselines live for the lifetime of the instance, exactly as the deleted
/// `createProcessResourceSampler` closure held them.
///
/// `logical_cpu_count` is `os.cpus().length` as resolved by the TypeScript wrapper,
/// so the percentage divisor is bit-for-bit the one the predecessor used.
#[napi]
pub struct ProcessResourceSampler {
    state: Arc<Mutex<SamplerState>>,
    cancelled: Arc<AtomicBool>,
}

#[napi]
impl ProcessResourceSampler {
    #[napi(constructor)]
    pub fn new(logical_cpu_count: f64) -> Self {
        Self {
            state: Arc::new(Mutex::new(SamplerState::new(logical_cpu_count))),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Reads the machine-wide process table and folds it into the baselines.
    ///
    /// Resolves to `null` — the predecessor's `undefined` — when the round could not
    /// be completed or was cancelled. It is never a partial table.
    #[napi]
    pub fn sample(&self, now_ms: f64) -> AsyncTask<SampleTask> {
        // Cleared here, on the JS thread, so the ordering is: any `cancel()` issued
        // after this call returns is guaranteed to be seen by this round.
        self.cancelled.store(false, Ordering::SeqCst);
        AsyncTask::new(SampleTask {
            state: Arc::clone(&self.state),
            cancelled: Arc::clone(&self.cancelled),
            now_ms,
        })
    }

    /// Abandons the in-flight round (invariant 6: abort parity). The adapter wires
    /// this to the `AbortSignal` it already accepted; the round resolves to `null`
    /// and the adapter re-throws `AbortError` at the same point the predecessor did.
    #[napi]
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
}

pub struct SampleTask {
    state: Arc<Mutex<SamplerState>>,
    cancelled: Arc<AtomicBool>,
    now_ms: f64,
}

impl Task for SampleTask {
    type Output = Option<Vec<NativeProcessResourceSample>>;
    type JsValue = Option<Vec<NativeProcessResourceSample>>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let cancelled = || self.cancelled.load(Ordering::SeqCst);
        let Some(rows) = read_table(&cancelled) else {
            return Ok(None);
        };
        if cancelled() {
            return Ok(None);
        }
        let samples = self
            .state
            .lock()
            .map_err(|_| napi::Error::from_reason("zcode-sysinfo: sampler state poisoned"))?
            .sample(rows, self.now_ms);
        Ok(Some(samples.into_iter().map(Into::into).collect()))
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}
