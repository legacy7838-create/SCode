//! The machine-wide process resource table: one row per live PID.
//!
//! Replaces `createProcessResourceTableReader`
//! (`packages/services/src/process/processResourceSampler.ts:188-267`) in full,
//! including the two child-process spawns it performed on macOS (`ps`) and Windows
//! (`powershell.exe` + `Get-CimInstance Win32_Process`). Both are gone: the read is
//! now in-process, which is what invariant 5 asks for.
//!
//! Platform split (docs/specs/rust-native-sysinfo.md §3.3):
//!   * Linux — the hand-rolled `/proc` reader in [`crate::linux`], because `sysinfo`
//!     enumerates threads and reads RSS from a different source than the contract.
//!   * macOS / Windows — `sysinfo`, whose per-platform field sources match the
//!     deleted readers exactly (`pti_resident_size` and `WorkingSetSize`).

/// One row of the machine-wide process table.
///
/// Field names and units are the wire contract (invariant 3) and are unchanged from
/// the deleted `ProcessResourceRow` (`processResourceSampler.ts:32-44`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceRow {
    pub pid: u32,
    pub ppid: u32,
    /// Resident set size in **kilobytes**, from `VmRSS` on Linux and the platform's
    /// resident-size field elsewhere.
    pub rss_kb: u64,
    /// Cumulative user+system CPU time in **whole milliseconds**.
    pub cpu_time_ms: u64,
    /// Command name or executable path, as the platform reports it.
    pub command: String,
}

/// Builds a row from the platform's raw readings, applying the unit conversions the
/// wire contract fixes: bytes → kilobytes, and the platform's accumulated CPU time is
/// already in whole milliseconds.
pub fn row_from_raw(
    pid: u32,
    ppid: u32,
    memory_bytes: u64,
    accumulated_cpu_time_ms: u64,
    command: String,
) -> ResourceRow {
    ResourceRow {
        pid,
        ppid,
        rss_kb: memory_bytes / 1024,
        cpu_time_ms: accumulated_cpu_time_ms,
        command,
    }
}

/// Reads the whole machine-wide process table, sorted by pid.
///
/// `None` means "this round failed, skip it" — the same contract as the predecessor's
/// `ProcessResourceTableReader` returning `undefined`
/// (`processResourceSampler.ts:187`). It is never a partial table.
pub fn read_table(cancel: &(dyn Fn() -> bool + Sync)) -> Option<Vec<ResourceRow>> {
    #[cfg(target_os = "linux")]
    {
        crate::linux::read_linux_table_at(std::path::Path::new("/proc"), cancel)
    }
    #[cfg(not(target_os = "linux"))]
    {
        read_sysinfo_table(cancel)
    }
}

/// macOS / Windows reader, backed by `sysinfo`.
///
/// # Recorded divergence (docs/specs/rust-native-sysinfo.md §5.2 D5)
///
/// On Windows the predecessor parsed `($_.KernelModeTime + $_.UserModeTime) / 10_000`
/// as a float, so `cpuTimeMs` could carry a sub-millisecond fraction. `sysinfo`
/// truncates the same two FILETIMEs to whole milliseconds
/// (`sysinfo-0.39.6/src/windows/process.rs:1097`). The row is therefore up to 1 ms
/// lower, which can move `cpuPercent` by at most 0.1 percentage points at a 1 s
/// sampling interval. The direction is one-way: a process is never credited CPU time
/// it did not consume.
///
/// # Why this is compiled but not called on Linux
///
/// `read_table` serves Linux from [`crate::linux`]. This function still compiles and
/// is still exercised by the test below on every platform, so the macOS and Windows
/// row mapping — the only part of this crate that cannot be executed on the porting
/// host — is not left entirely unverified. It is never on the Linux hot path: it
/// enumerates threads and reads RSS from the wrong source there (spec §3.3).
pub fn read_sysinfo_table(cancel: &(dyn Fn() -> bool + Sync)) -> Option<Vec<ResourceRow>> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

    let mut system = System::new();
    // `nothing()` keeps the refresh to the two expensive fields this contract needs.
    // `parent` and `name` come from the platform's mandatory process snapshot.
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );

    let mut rows: Vec<ResourceRow> = Vec::with_capacity(512);
    for (pid, process) in system.processes() {
        if cancel() {
            return None;
        }
        rows.push(row_from_raw(
            pid.as_u32(),
            process.parent().map_or(0, |p| p.as_u32()),
            process.memory(),
            process.accumulated_cpu_time(),
            process.name().to_string_lossy().into_owned(),
        ));
    }
    rows.sort_by_key(|row| row.pid);
    Some(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_from_raw_converts_bytes_to_kilobytes_and_passes_ms_through() {
        let row = row_from_raw(7, 1, 4096 * 1024 + 512, 2800, "bash".into());
        assert_eq!(row.rss_kb, 4096, "bytes → kB truncates, as /1024 always did");
        assert_eq!(row.cpu_time_ms, 2800);
        assert_eq!(row.command, "bash");
    }

    #[test]
    fn sysinfo_table_is_never_empty_for_a_live_host() {
        let rows = read_sysinfo_table(&|| false).expect("sysinfo read must not report failure");
        assert!(!rows.is_empty(), "a live host always has at least one process");
        let me = rows
            .iter()
            .find(|row| row.pid == std::process::id())
            .expect("the reading process must appear in its own table");
        assert!(me.rss_kb > 0, "resident size must be reported in kB");
        assert!(me.cpu_time_ms > 0, "cputime must be reported in ms");
        assert!(!me.command.is_empty());
        assert!(
            rows.windows(2).all(|w| w[0].pid < w[1].pid),
            "rows are sorted by pid on every platform"
        );
    }

    #[test]
    fn sysinfo_table_abandons_the_round_when_cancelled() {
        assert!(
            read_sysinfo_table(&|| true).is_none(),
            "a cancelled round reports failure, never a partial table"
        );
    }
}
