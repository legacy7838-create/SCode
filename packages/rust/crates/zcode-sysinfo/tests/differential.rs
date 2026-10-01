//! Fixture differential and failure-mode corpus for `zcode-sysinfo`.
//!
//! Every case is a **recorded** input/output pair: the byte input is a real
//! `/proc/<pid>/stat` or `/proc/<pid>/status` shape, and the expected value is what
//! the deleted TypeScript produced from the same bytes
//! (`packages/services/src/process/processResourceSampler.ts`, before this port).
//! Case ids match docs/specs/rust-native-sysinfo.md §5.1 (F1-F16) and §6 (E1-E13).

use std::path::{Path, PathBuf};

use zcode_sysinfo::linux::{parse_proc_stat, parse_vm_rss_kb, read_linux_table_at};
use zcode_sysinfo::sampler::{SamplerState, CPU_BASELINE_TTL_MS};
use zcode_sysinfo::table::ResourceRow;

// ---------------------------------------------------------------- F1..F4, F9: /proc/<pid>/stat

/// A well-formed `stat` line. `utime` is field 14 (250) and `stime` is field 15 (30).
const STAT_BASH: &str = "1234 (bash) S 1 1234 1234 0 -1 4194304 100 0 0 0 250 30 0 0 20 0 1 0 98765 12345678 900 18446744073709551615 1 1 1 1 1 1 0 0 0 0 0 0 17 3 0 0 0 0 0";

#[test]
fn f1_parses_pid_ppid_command_and_cputime() {
    let parsed = parse_proc_stat(STAT_BASH.as_bytes()).expect("F1 must parse");
    assert_eq!(parsed.pid, 1234);
    assert_eq!(parsed.ppid, 1);
    assert_eq!(parsed.command, "bash");
    // (250 + 30) ticks at USER_HZ 100 = 2800 ms. The predecessor computed
    // `Math.round(((utime + stime) * 1000) / 100)`, which is the same integer.
    assert_eq!(parsed.cpu_time_ms, 2800);
}

#[test]
fn f2_command_splits_on_the_last_paren_and_keeps_inner_parens() {
    let stat = "9 (my (weird) proc) S 4 9 9 0 -1 0 0 0 0 0 100 50 0 0 20 0 1 0 1 2 3 4 5 6 7 8 9 0 0 0 0 0 0";
    let parsed = parse_proc_stat(stat.as_bytes()).expect("F2 must parse");
    assert_eq!(parsed.pid, 9);
    assert_eq!(parsed.ppid, 4);
    assert_eq!(parsed.command, "my (weird) proc");
    assert_eq!(parsed.cpu_time_ms, 1500);
}

#[test]
fn f3_stat_without_a_closing_paren_is_rejected() {
    let stat = "1234 (bash S 1 1234 1234 0 -1 0 0 0 0 0 0 250 30 0 0 20";
    assert!(parse_proc_stat(stat.as_bytes()).is_none(), "F3 must reject");
}

#[test]
fn f3_stat_with_the_paren_before_the_open_paren_is_rejected() {
    let stat = ") 1234 (bash) S 1 1234 1234 0 -1 0 0 0 0 0 0 250 30";
    assert!(parse_proc_stat(stat.as_bytes()).is_none(), "F3 must reject");
}

#[test]
fn f4_non_numeric_utime_rejects_the_whole_row() {
    let stat = "1234 (bash) S 1 1234 1234 0 -1 0 0 0 0 0 0 abc 30 0 0 20 0 1 0 1 2 3";
    assert!(parse_proc_stat(stat.as_bytes()).is_none(), "F4 must reject");
}

#[test]
fn f4_truncated_stat_rejects_the_whole_row() {
    // Fewer than 13 fields after the command: the predecessor read `rest[11]`/`rest[12]`
    // as `undefined`, and `Number(undefined)` is NaN, so the row was dropped.
    let stat = "1234 (bash) S 1 1234 1234 0 -1 0 0 0";
    assert!(parse_proc_stat(stat.as_bytes()).is_none(), "F4 must reject");
}

#[test]
fn f9_pid_zero_and_negative_fields_reject_the_row() {
    let zero = "0 (bash) S 1 1234 1234 0 -1 0 0 0 0 0 0 250 30 0 0 20";
    assert!(parse_proc_stat(zero.as_bytes()).is_none(), "pid 0 must reject");
    let negative = "1234 (bash) S 1 1234 1234 0 -1 0 0 0 0 0 0 -5 30 0 0 20";
    assert!(
        parse_proc_stat(negative.as_bytes()).is_none(),
        "a negative utime must reject"
    );
    let negative_ppid = "1234 (bash) S -3 1234 1234 0 -1 0 0 0 0 0 0 250 30 0 0 20";
    assert!(
        parse_proc_stat(negative_ppid.as_bytes()).is_none(),
        "a negative ppid must reject"
    );
}
#[test]
fn ppid_zero_is_accepted_because_kernel_threads_report_it() {
    // pid 2 (kthreadd) has ppid 0 on Linux. The predecessor required `ppid >= 0`,
    // not `ppid > 0`, so these rows must survive.
    let stat = "2 (kthreadd) S 0 2 0 0 -1 0 0 0 0 0 10 20 0 0 20 0 1 0 1 2 3";
    let parsed = parse_proc_stat(stat.as_bytes()).expect("ppid 0 must parse");
    assert_eq!(parsed.ppid, 0);
    assert_eq!(parsed.cpu_time_ms, 300);
}

// ---------------------------------------------------------------- F5..F8: /proc/<pid>/status

#[test]
fn f5_reads_vmrss_in_kilobytes() {
    let status = "Name:\tbash\nState:\tS (sleeping)\nVmPeak:\t  1234567 kB\nVmRSS:\t   1234 kB\n";
    assert_eq!(parse_vm_rss_kb(status.as_bytes()), 1234);
}

#[test]
fn f6_missing_vmrss_is_zero_not_a_rejected_row() {
    let status = "Name:\tbash\nState:\tS (sleeping)\nThreads:\t1\n";
    assert_eq!(
        parse_vm_rss_kb(status.as_bytes()),
        0,
        "the predecessor returned 0 for a non-matching regex"
    );
}

#[test]
fn f7_zero_vmrss_is_zero() {
    let status = "Name:\tbash\nVmRSS:\t 0 kB\n";
    assert_eq!(parse_vm_rss_kb(status.as_bytes()), 0);
}

#[test]
fn f8_picks_vmrss_not_the_first_vm_line() {
    // 20 MB VmPeak, 512 kB VmRSS: the predecessor's regex was anchored on `^VmRSS:`,
    // so a naive "first kB number" reader would report 20971520 here.
    let status = "VmPeak:\t  20971520 kB\nVmSize:\t   1048576 kB\nVmRSS:\t      512 kB\n";
    assert_eq!(parse_vm_rss_kb(status.as_bytes()), 512);
}

#[test]
fn f8_ignores_crlf_and_a_vmrss_like_prefix_that_is_not_vmrs() {
    let status = "VmRSSX:\t 9999 kB\r\nVmRSS:\t 7 kB\r\n";
    assert_eq!(parse_vm_rss_kb(status.as_bytes()), 7);
}

// ---------------------------------------------------------------- F10..F16: the sampler

fn row(pid: u32, cpu_time_ms: u64, command: &str) -> ResourceRow {
    ResourceRow {
        pid,
        ppid: 1,
        rss_kb: 2048,
        cpu_time_ms,
        command: command.into(),
    }
}

#[test]
fn f10_first_sample_has_no_delta_baseline() {
    let mut state = SamplerState::new(6.0);
    let samples = state.sample(vec![row(10, 5_000, "bash")], 1_000.0);
    assert_eq!(samples[0].cpu_percent, 0.0);
}

#[test]
fn f11_second_sample_divides_by_wall_clock_and_by_logical_cpus() {
    let mut state = SamplerState::new(6.0);
    state.sample(vec![row(10, 5_000, "bash")], 1_000.0);
    // 500 ms of CPU over 2000 ms of wall clock on 6 cores = 4.1666…%, rounded to 4.2.
    let samples = state.sample(vec![row(10, 5_500, "bash")], 3_000.0);
    assert_eq!(samples[0].cpu_percent, 4.2);
    assert_eq!(samples[0].rss_kb, 2048);
    assert_eq!(samples[0].command, "bash");
}

#[test]
fn f11_percentage_is_machine_wide_not_per_core() {
    // One core fully busy on 6 cores is 16.7%, not 100%.
    let mut state = SamplerState::new(6.0);
    state.sample(vec![row(10, 0, "bash")], 0.0);
    let samples = state.sample(vec![row(10, 1_000, "bash")], 1_000.0);
    assert_eq!(samples[0].cpu_percent, 16.7);
}

#[test]
fn f12_a_changed_command_is_treated_as_pid_reuse() {
    let mut state = SamplerState::new(1.0);
    state.sample(vec![row(10, 0, "bash")], 0.0);
    let samples = state.sample(vec![row(10, 5_000, "node")], 1_000.0);
    assert_eq!(
        samples[0].cpu_percent, 0.0,
        "a different command re-establishes the baseline"
    );
}

#[test]
fn f13_cputime_going_backwards_is_treated_as_pid_reuse() {
    let mut state = SamplerState::new(1.0);
    state.sample(vec![row(10, 5_000, "bash")], 0.0);
    let samples = state.sample(vec![row(10, 10, "bash")], 1_000.0);
    assert_eq!(samples[0].cpu_percent, 0.0);
}

#[test]
fn f14_two_samples_in_the_same_millisecond_have_no_elapsed_time() {
    let mut state = SamplerState::new(1.0);
    state.sample(vec![row(10, 0, "bash")], 1_000.0);
    let samples = state.sample(vec![row(10, 5_000, "bash")], 1_000.0);
    assert_eq!(samples[0].cpu_percent, 0.0);
}

#[test]
fn f15_percentage_is_clamped_and_rounded_to_one_decimal() {
    let mut state = SamplerState::new(1.0);
    state.sample(vec![row(10, 0, "a"), row(20, 0, "b")], 0.0);
    // 100% of one core on one core; 120% is impossible but must still clamp.
    let samples = state.sample(vec![row(10, 1_000, "a"), row(20, 1_200, "b")], 1_000.0);
    assert_eq!(samples[0].cpu_percent, 100.0);
    assert_eq!(samples[1].cpu_percent, 100.0);

    let mut state = SamplerState::new(1.0);
    state.sample(vec![row(10, 0, "a")], 0.0);
    let samples = state.sample(vec![row(10, 1_004, "a")], 1_000.0);
    assert_eq!(samples[0].cpu_percent, 100.0, "100.04% rounds to 100.0");
}

#[test]
fn f16_a_non_positive_logical_cpu_count_is_clamped_to_one() {
    for count in [0.0, -3.0] {
        let mut state = SamplerState::new(count);
        state.sample(vec![row(10, 0, "a")], 0.0);
        let samples = state.sample(vec![row(10, 1_000, "a")], 1_000.0);
        assert_eq!(
            samples[0].cpu_percent, 100.0,
            "logicalCpuCount={count} must behave as 1"
        );
    }
}

#[test]
fn f16_a_nan_logical_cpu_count_zeroes_the_percentage_exactly_as_javascript_did() {
    // Recorded differential: replaying the legacy sampler over this fixture returned
    // 0, not 100. `Math.max(1, NaN)` is `NaN` in JavaScript, the percentage becomes
    // `NaN`, and `roundPercent` maps a non-finite value to 0. Clamping NaN to 1 in
    // Rust would have reported a saturated core as 100%.
    let mut state = SamplerState::new(f64::NAN);
    state.sample(vec![row(10, 0, "a")], 0.0);
    let samples = state.sample(vec![row(10, 1_000, "a")], 1_000.0);
    assert_eq!(samples[0].cpu_percent, 0.0);
}

// ---------------------------------------------------------------- E1..E3, E12: the reader

struct FakeProc {
    root: PathBuf,
}

impl FakeProc {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("zcode-sysinfo-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp dir");
        Self { root }
    }

    fn pid(&self, pid: &str, stat: &str, status: &str) -> &Self {
        let dir = self.root.join(pid);
        std::fs::create_dir_all(&dir).expect("pid dir");
        std::fs::write(dir.join("stat"), stat).expect("stat");
        std::fs::write(dir.join("status"), status).expect("status");
        self
    }

    fn entry(&self, name: &str) -> &Self {
        std::fs::create_dir_all(self.root.join(name)).expect("entry dir");
        self
    }

    fn read(&self) -> Option<Vec<ResourceRow>> {
        read_linux_table_at(&self.root, &|| false)
    }
}

impl Drop for FakeProc {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn reads_a_whole_table_and_skips_everything_that_is_not_a_pid() {
    let proc = FakeProc::new("whole");
    proc.pid("1234", STAT_BASH, "VmRSS:\t 1234 kB\n")
        .pid("2", "2 (kthreadd) S 0 2 0 0 -1 0 0 0 0 0 0 10 20 0 0 20", "VmRSS:\t 64 kB\n")
        .entry("self")
        .entry("meminfo")
        .entry("1234abc")
        .entry("0000x");
    let rows = proc.read().expect("the root is listable");
    assert_eq!(rows.len(), 2, "only pure-digit entries are PIDs");
    assert_eq!(rows[0].pid, 2);
    assert_eq!(rows[0].rss_kb, 64);
    assert_eq!(rows[1].pid, 1234);
    assert_eq!(rows[1].rss_kb, 1234);
    assert_eq!(rows[1].command, "bash");
}

#[test]
fn e1_a_pid_that_exits_between_readdir_and_open_is_skipped() {
    // `4242` has a directory (so `readdir` sees it) but no `stat`/`status` files,
    // which is exactly what a process exiting mid-scan looks like.
    let proc = FakeProc::new("exiting");
    proc.pid("1234", STAT_BASH, "VmRSS:\t 10 kB\n").entry("4242");
    let rows = proc.read().expect("the root is listable");
    assert_eq!(rows.len(), 1, "the half-vanished pid is skipped, not an error");
}

#[test]
fn e1_a_malformed_stat_is_skipped_without_failing_the_round() {
    let proc = FakeProc::new("malformed");
    proc.pid("1234", STAT_BASH, "VmRSS:\t 10 kB\n")
        .pid("5555", "5555 (x) S 1 5555 5555 0 -1 0 0 0 0 0 0 oops 0", "VmRSS:\t 10 kB\n");
    let rows = proc.read().expect("the root is listable");
    assert_eq!(rows.len(), 1);
}

#[test]
fn e2_an_unlistable_root_reports_failure_not_an_empty_table() {
    let missing = std::env::temp_dir().join("zcode-sysinfo-does-not-exist-xyz");
    let _ = std::fs::remove_dir_all(&missing);
    assert!(
        read_linux_table_at(&missing, &|| false).is_none(),
        "E2: the round is skipped, and an empty table never masquerades as complete"
    );
    assert!(Path::new(&missing).exists() == false);
}

#[test]
fn e5_a_status_without_vmrs_keeps_the_row_with_zero_rss() {
    let proc = FakeProc::new("novmrss");
    proc.pid("1234", STAT_BASH, "Name:\tbash\n");
    let rows = proc.read().expect("the root is listable");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].rss_kb, 0);
}

// ---------------------------------------------------------------- E6, E9, E11: sampler lifecycle

#[test]
fn e9_a_baseline_unseen_for_longer_than_the_ttl_is_dropped() {
    let mut state = SamplerState::new(1.0);
    state.sample(vec![row(10, 0, "a"), row(20, 0, "b")], 0.0);
    // 20 keeps appearing, 10 goes quiet for longer than the TTL.
    state.sample(vec![row(20, 100, "b")], CPU_BASELINE_TTL_MS + 1.0);
    // 10 comes back with a huge cputime: if its stale baseline had survived, the
    // delta would be enormous and the percentage would clamp to 100.
    let samples = state.sample(vec![row(10, 9_000, "a"), row(20, 200, "b")], 2_000.0);
    let revived = samples.iter().find(|s| s.pid == 10).expect("pid 10 returns");
    assert_eq!(
        revived.cpu_percent, 0.0,
        "the stale baseline must have been evicted, so this is a first sample again"
    );
}

#[test]
fn e9_a_baseline_seen_every_round_is_never_evicted() {
    let mut state = SamplerState::new(1.0);
    let mut at = 0.0;
    // Each round burns exactly as much wall clock as the elapsed gap, so a surviving
    // baseline reports 100% while an evicted one would report 0%.
    for step in 0..5u64 {
        state.sample(vec![row(10, step * 100_000, "a")], at);
        at += CPU_BASELINE_TTL_MS + 1.0;
    }
    let samples = state.sample(vec![row(10, 500_000, "a")], at);
    assert_eq!(
        samples[0].cpu_percent, 100.0,
        "a continuously-seen pid keeps its baseline across arbitrarily long gaps"
    );
}
#[test]
fn e11_a_non_finite_clock_yields_zero_percent_instead_of_nan() {
    let mut state = SamplerState::new(1.0);
    state.sample(vec![row(10, 0, "a")], f64::NAN);
    let samples = state.sample(vec![row(10, 5_000, "a")], 1_000.0);
    assert_eq!(samples[0].cpu_percent, 0.0);
    assert!(samples[0].cpu_percent.is_finite());
}

#[test]
fn e11_a_clock_going_backwards_yields_zero_percent() {
    let mut state = SamplerState::new(1.0);
    state.sample(vec![row(10, 0, "a")], 10_000.0);
    let samples = state.sample(vec![row(10, 5_000, "a")], 1_000.0);
    assert_eq!(samples[0].cpu_percent, 0.0);
}

#[test]
fn e12_cancelling_between_pids_abandons_the_whole_round() {
    let proc = FakeProc::new("cancel");
    for pid in 1..40 {
        proc.pid(&pid.to_string(), STAT_BASH, "VmRSS:\t 10 kB\n");
    }
    // A cancel that trips after the tenth PID must yield no rows at all, because the
    // per-PID reads run in parallel: a round is complete only if every worker finished.
    let seen = std::sync::atomic::AtomicU32::new(0);
    let rows = read_linux_table_at(&proc.root, &|| {
        seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 10
    });
    assert!(rows.is_none(), "a cancelled round is never a partial table");
}

// ---------------------------------------------------------------- live-host smoke

#[test]
fn reads_this_hosts_own_process() {
    let rows = read_linux_table_at(Path::new("/proc"), &|| false).expect("/proc is listable");
    let me = rows
        .iter()
        .find(|row| row.pid == std::process::id())
        .expect("the test binary appears in its own table");
    assert!(me.rss_kb > 0, "resident size is reported in kB");
    assert!(me.command.len() > 0);
    assert!(rows.windows(2).all(|w| w[0].pid != w[1].pid), "PIDs are unique");
}
