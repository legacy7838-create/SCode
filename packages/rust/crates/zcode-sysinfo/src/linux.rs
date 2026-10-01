//! Linux `/proc` reader for the machine-wide process resource table.
//!
//! Replaces `packages/services/src/process/processResourceSampler.ts:117-152`
//! (`parseLinuxProcStat` + `parseLinuxVmRssKb`) and the `linux` branch of
//! `createProcessResourceTableReader` (`:213-252`).
//!
//! # Why this is hand-rolled instead of `sysinfo`
//!
//! Two measured reasons, both recorded in `docs/specs/rust-native-sysinfo.md` §3.3:
//!
//! 1. `sysinfo` 0.39 walks `/proc/<pid>/task/*` and creates a `Process` for every
//!    *thread*, with no public opt-out (`sysinfo-0.39.6/src/unix/linux/process.rs:965`).
//!    On the porting host that is 993 entries for 296 processes.
//! 2. `sysinfo`'s `Process::memory()` reads resident pages from `statm`; the
//!    predecessor read `VmRSS` from `/proc/<pid>/status`. Those are not the same
//!    number: measured over 298 PIDs on an idle host, 131 differed, by up to 1060 kB.
//!
//! Everything here is byte parsing over two procfs files. No FFI, no platform
//! API, no `unsafe`, and the only per-OS code in the crate is code that runs on
//! the host that can test it.

use std::path::Path;

use crate::table::ResourceRow;

/// `/proc/<pid>/stat` always reports `utime`/`stime` in USER_HZ units, and USER_HZ is
/// pegged at 100 regardless of the kernel's own HZ. Mirrors the constant the
/// predecessor carried at `processResourceSampler.ts:24`.
pub const LINUX_CLOCK_TICKS_PER_SECOND: u64 = 100;

/// What `/proc/<pid>/stat` contributes to a resource-table row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcStat {
    pub pid: u32,
    pub ppid: u32,
    /// The `comm` field, verbatim, including any spaces or parentheses the process
    /// put in its own name. Kernel-truncated to 15 bytes.
    pub command: String,
    /// Cumulative user+system CPU, in whole milliseconds.
    pub cpu_time_ms: u64,
}

/// Parses `/proc/<pid>/stat`.
///
/// Byte-for-byte the same accept/reject decisions as the predecessor's
/// `parseLinuxProcStat` (`processResourceSampler.ts:117-149`):
///
/// * the command is split on the **last** `)`, because `comm` may itself contain
///   `)` — the predecessor's own comment at `:116`;
/// * a missing `(`, a `)` before the `(`, a non-numeric or negative field, or
///   `pid <= 0` all reject the whole row. A rejected row is skipped, never
///   zero-filled.
pub fn parse_proc_stat(content: &[u8]) -> Option<ProcStat> {
    let open = content.iter().position(|b| *b == b'(')?;
    let close = content.iter().rposition(|b| *b == b')')?;
    if close < open {
        return None;
    }

    let pid = parse_non_negative_integer(trim_ascii_whitespace(&content[..open]))?;
    if pid == 0 || u32::try_from(pid).is_err() {
        return None;
    }

    let command = std::str::from_utf8(&content[open + 1..close])
        .ok()?
        .to_string();

    // Field 1 is pid and field 2 is `(comm)`, so the i-th whitespace-separated token
    // after the command is original field `i + 3`: `ppid` is field 4, `utime` is
    // field 14, `stime` is field 15. One pass, stopping at the last field needed.
    let (mut ppid, mut utime, mut stime) = (None, None, None);
    for (index, field) in FieldIter::new(&content[close + 1..]).enumerate() {
        match index {
            1 => ppid = parse_non_negative_integer(field),
            11 => utime = parse_non_negative_integer(field),
            12 => stime = parse_non_negative_integer(field),
            _ => {}
        }
        if index >= 12 {
            break;
        }
    }
    let (ppid, utime, stime) = (ppid?, utime?, stime?);

    Some(ProcStat {
        pid: pid as u32,
        ppid: u32::try_from(ppid).ok()?,
        command,
        // The predecessor computed `Math.round(((utime + stime) * 1000) / 100)`.
        // With USER_HZ = 100 that is exactly `(utime + stime) * 10`, and `t * 1000`
        // stays far below 2^53 for any real process, so the JS was already on an
        // exact integer and `Math.round` was a no-op. Integer arithmetic here is
        // therefore bit-identical, not an approximation.
        cpu_time_ms: utime
            .saturating_add(stime)
            .saturating_mul(1_000)
            / LINUX_CLOCK_TICKS_PER_SECOND,
    })
}

/// Parses `VmRSS:\t 1234 kB` out of `/proc/<pid>/status`.
///
/// Mirrors `parseLinuxVmRssKb` (`processResourceSampler.ts:151-154`): a status file
/// with no `VmRSS` line yields `0`, it does **not** reject the row — the predecessor
/// returned 0 for a non-matching regex and the resource-manager window renders that.
pub fn parse_vm_rss_kb(content: &[u8]) -> u64 {
    content
        .split(|b| *b == b'\n')
        .find_map(match_vm_rss_line)
        .unwrap_or(0)
}

fn match_vm_rss_line(line: &[u8]) -> Option<u64> {
    let rest = trim_start_ascii_whitespace(line.strip_prefix(b"VmRSS:")?);
    let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    let value: u64 = std::str::from_utf8(&rest[..digits]).ok()?.parse().ok()?;
    // The predecessor's regex required the `kB` unit, so a bare number under a
    // different suffix is not a VmRSS line we trust.
    trim_start_ascii_whitespace(&rest[digits..])
        .starts_with(b"kB")
        .then_some(value)
}

fn trim_start_ascii_whitespace(mut bytes: &[u8]) -> &[u8] {
    while let [first, rest @ ..] = bytes {
        if first.is_ascii_whitespace() {
            bytes = rest;
        } else {
            break;
        }
    }
    bytes
}

fn trim_ascii_whitespace(bytes: &[u8]) -> &[u8] {
    let bytes = trim_start_ascii_whitespace(bytes);
    let mut end = bytes.len();
    while end > 0 && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    &bytes[..end]
}

/// The predecessor's `parseNonNegativeInteger` (`processResourceSampler.ts:69-72`):
/// `Number(text)` must be an integer `>= 0`. `/proc` only ever emits digits or a
/// leading `-`, so this accepts an optional `+` then digits and rejects everything
/// else — including the empty string, which `Number("")` would have read as 0.
fn parse_non_negative_integer(bytes: &[u8]) -> Option<u64> {
    let bytes = bytes.strip_prefix(b"+".as_slice()).unwrap_or(bytes);
    if bytes.is_empty() {
        return None;
    }
    let mut value: u64 = 0;
    for byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value.checked_mul(10)?.checked_add((byte - b'0') as u64)?;
    }
    Some(value)
}

/// Whitespace-separated field iterator with the same semantics as JS
/// `String.prototype.split(/\s+/)` **after** a `.trim()`: leading and trailing
/// whitespace is dropped, so no empty field is ever produced.
struct FieldIter<'a> {
    rest: &'a [u8],
}

impl<'a> Iterator for FieldIter<'a> {
    type Item = &'a [u8];

    fn next(&mut self) -> Option<Self::Item> {
        let rest = trim_start_ascii_whitespace(self.rest);
        if rest.is_empty() {
            self.rest = rest;
            return None;
        }
        let end = rest
            .iter()
            .position(|b| b.is_ascii_whitespace())
            .unwrap_or(rest.len());
        let (field, tail) = rest.split_at(end);
        self.rest = tail;
        Some(field)
    }
}

impl<'a> FieldIter<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self {
            rest: trim_ascii_whitespace(bytes),
        }
    }
}

/// procfs files are a single short line, so one 4 KiB stack buffer per file is the
/// whole read: `std::fs::read` would add an `fstat` size probe and a trailing
/// zero-length read to every one of the ~530 files a round touches.
const PROCFS_READ_BUFFER: usize = 4 * 1024;

/// Reads one procfs file with exactly one `open`, one `read` and one `close`.
/// Returns `None` when the file cannot be opened, which is how a process that exits
/// mid-scan presents itself.
fn read_procfs_file(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read;

    let mut file = std::fs::File::open(path).ok()?;
    let mut buffer = [0u8; PROCFS_READ_BUFFER];
    let read = file.read(&mut buffer).ok()?;
    Some(buffer[..read].to_vec())
}

/// Reads the whole machine-wide process table from `root` (normally `/proc`).
///
/// Returns `None` — never a partial table — when `root` itself cannot be listed, so
/// the consumer's "skip this round" branch is preserved exactly
/// (`processResourceSampler.ts:216-218`).
///
/// The per-PID reads run on the rayon pool. The predecessor issued them as
/// `Promise.all` over `readFile`, i.e. across the 4-thread libuv pool, so a serial
/// reader is *slower* than the code it replaces on the very workload the measurement
/// in spec §1.1 is about — measured at 6.68 ms for 267 PIDs before this change.
///
/// `cancel` is polled before every PID and once more at the end; returning `true`
/// abandons the round and yields `None` (invariant 6, abort parity).
pub fn read_linux_table_at(
    root: &Path,
    cancel: &(dyn Fn() -> bool + Sync),
) -> Option<Vec<ResourceRow>> {
    use rayon::prelude::*;

    let pid_dirs: Vec<std::path::PathBuf> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            // The predecessor filtered on `/^\d+$/`, which also excludes non-ASCII
            // digits.
            if name.is_empty() || !name.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            Some(root.join(name))
        })
        .collect();

    let mut rows: Vec<ResourceRow> = pid_dirs
        .par_iter()
        .filter_map(|dir| {
            if cancel() {
                return None;
            }
            // A process exiting between the readdir and the open is normal and is
            // skipped (`processResourceSampler.ts:242`), not an error.
            let stat = read_procfs_file(&dir.join("stat"))?;
            let parsed = parse_proc_stat(&stat)?;
            let status = read_procfs_file(&dir.join("status"))?;
            Some(ResourceRow {
                pid: parsed.pid,
                ppid: parsed.ppid,
                rss_kb: parse_vm_rss_kb(&status),
                cpu_time_ms: parsed.cpu_time_ms,
                command: parsed.command,
            })
        })
        .collect();

    if cancel() {
        return None;
    }
    rows.sort_by_key(|row| row.pid);
    Some(rows)
}
