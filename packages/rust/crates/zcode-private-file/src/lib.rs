//! Private-file persistence: inter-process locking, atomic writes, and
//! corruption backups.
//!
//! Transcribed from `packages/shared/src/node/privateFilePersistence.ts` and
//! `packages/shared/src/node/atomicFileLock.ts`.
//!
//! # Why this module exists
//!
//! The credential and settings stores are read-modify-write on a whole JSON
//! file, and more than one process touches them: the Tauri host, the Electron
//! desktop host, and the CLI adapter all read the same `~/.zcode/v2` directory.
//! An in-process `Mutex` cannot make that safe — it orders threads inside one
//! process and does nothing about the others. Two writers that interleave
//! `read → modify → write` silently lose one of the writes, and for a
//! credential store a lost write is a logged-out user with no error anywhere.
//!
//! So the write path is the same three-step discipline as the original:
//!
//! 1. take a lock on a sibling `<file>.lock` directory,
//! 2. read, modify, and atomically replace while holding it,
//! 3. release, removing only our own owner file.
//!
//! The lock is a *directory* created with a non-recursive `mkdir`, because
//! `mkdir` is the one syscall that is atomically exclusive across processes and
//! needs no `O_EXCL`/`flock` dependency. Ownership is a uniquely named file
//! inside it, so a waiter can tell a live holder from a crashed one and reclaim
//! only the latter.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// Mirrors `DEFAULT_LOCK_RETRY_DELAYS_MS`.
const LOCK_RETRY_DELAYS_MS: [u64; 5] = [25, 50, 100, 200, 400];
/// Mirrors `DEFAULT_LOCK_OWNERLESS_GRACE_MS`.
const LOCK_OWNERLESS_GRACE_MS: u64 = 100;
/// Mirrors `DEFAULT_LOCK_MAX_WAIT_MS`.
const LOCK_MAX_WAIT_MS: u64 = 8_000;
/// Mirrors `DEFAULT_RENAME_RETRY_DELAYS_MS`.
const RENAME_RETRY_DELAYS_MS: [u64; 5] = [50, 100, 200, 400, 800];
/// Mirrors `MAX_LOCK_METADATA_CLOCK_SKEW_MS`: a `createdAt` further in the
/// future than this is treated as unusable, not as "not yet stale".
const MAX_LOCK_METADATA_CLOCK_SKEW_MS: u64 = 5 * 60_000;

/// The original's `ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE`, so the same client-side
/// handling applies to a Rust-host lock timeout as to a Node one.
pub const FILE_LOCK_TIMEOUT_ERROR_CODE: &str = "ZCODE_FILE_LOCK_TIMEOUT";

/// `EPERM`/`EBUSY`/`EACCES` are the three conditions the original retries a
/// rename under: on Windows an AV or the indexer can briefly hold the target.
const EPERM: i32 = 1;
const EBUSY: i32 = 16;
const EACCES: i32 = 13;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default()
}

fn error_code(error: &std::io::Error) -> Option<i32> {
    error.raw_os_error()
}

fn is_already_exists(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::AlreadyExists
}

fn is_retryable_rename_error(error: &std::io::Error) -> bool {
    matches!(error_code(error), Some(EPERM) | Some(EBUSY) | Some(EACCES))
}

/// `create_new(true)` maps to `O_CREAT | O_EXCL`, which is the atomic
/// create-if-absent the exclusive backup relies on.
fn open_new_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        // Set the mode at `open`, not with a follow-up `chmod`: a create-then-
        // chmod leaves a window where the secret is readable by anyone the
        // umask allows, which is the whole reason this file is private.
        options.mode(0o600);
    }
    options.open(path)
}

fn random_hex(bytes: usize) -> String {
    let mut raw = vec![0u8; bytes];
    getrandom(&mut raw);
    raw.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `rand::thread_rng` is not available in `no_std` builds and pulls in a
/// per-call initialisation cost, but this is the one place that genuinely needs
/// OS entropy. `getrandom` goes to the kernel directly.
fn getrandom(buffer: &mut [u8]) {
    use rand::RngCore as _;
    rand::thread_rng().fill_bytes(buffer);
}

// ---------------------------------------------------------------------------
// Inter-process lock
// ---------------------------------------------------------------------------

/// What a lock holder recorded about itself, so a waiter can tell a live
/// process from a crashed one.
struct LockMetadata {
    created_at: Option<u64>,
    pid: Option<u32>,
}

/// Parse the owner file. Anything unparseable degrades to "unknown" rather than
/// failing: the grace period still protects a live holder, so a corrupt owner
/// file costs a delay, not correctness.
fn parse_lock_metadata(raw: &str, observed_at: u64) -> LockMetadata {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return LockMetadata {
            created_at: None,
            pid: None,
        };
    };
    let parse_timestamp = |value: Option<&serde_json::Value>| -> Option<u64> {
        let millis = value?.as_f64()?;
        if !millis.is_finite() || millis < 0.0 {
            return None;
        }
        let millis = millis as u64;
        // A `createdAt` ahead of now means the writer's clock disagreed with
        // ours; treating it as valid would make the lock immortal.
        (millis <= observed_at + MAX_LOCK_METADATA_CLOCK_SKEW_MS).then_some(millis)
    };
    LockMetadata {
        created_at: parse_timestamp(value.get("createdAt")),
        pid: value
            .get("pid")
            .and_then(|pid| pid.as_u64())
            .and_then(|pid| (pid > 0 && pid <= u32::MAX as u64).then_some(pid as u32)),
    }
}

/// Is this pid still running?
///
/// `kill(pid, 0)` performs the permission and existence checks without
/// delivering a signal. Unlike the `getpwuid_r` call this module's sibling
/// replaced, it takes no caller-owned buffer, so there is no memory-safety
/// failure mode here — a wrong answer costs one lock retry, not a crash.
#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    // SAFETY: `kill` takes two scalars, reads no caller-owned memory, and
    // signal 0 performs only the existence/permission check. There is nothing
    // to uphold across the call and no way for it to corrupt our state.
    unsafe { kill(pid as i32, 0) == 0 || error_code(&std::io::Error::last_os_error()) != Some(3) }
}

/// No way to probe another process without a platform API, so assume every
/// owner is alive. A crashed Windows host then leaks its lock directory; the
/// ownerless grace period still reclaims locks written without a pid.
#[cfg(not(unix))]
fn is_process_alive(_pid: u32) -> bool {
    true
}

fn file_mtime_ms(path: &Path, observed_at: u64) -> Option<u64> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let millis = modified
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default();
    (millis <= observed_at + MAX_LOCK_METADATA_CLOCK_SKEW_MS).then_some(millis)
}

fn is_owner_file_reclaimable(owner_file: &Path, ownerless_grace_ms: u64) -> bool {
    let observed_at = now_ms();
    let Ok(raw) = std::fs::read_to_string(owner_file) else {
        // Unreadable: not reclaimable. Guessing here could steal a live lock.
        return false;
    };
    let metadata = parse_lock_metadata(&raw, observed_at);
    let created_at = metadata
        .created_at
        .or_else(|| file_mtime_ms(owner_file, observed_at))
        .unwrap_or(observed_at);
    let owner_exited = metadata.pid.is_some_and(|pid| !is_process_alive(pid));
    let ownerless_lock_is_stale =
        metadata.pid.is_none() && observed_at.saturating_sub(created_at) >= ownerless_grace_ms;
    owner_exited || ownerless_lock_is_stale
}

fn owner_files(lock_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(lock_dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("owner-") && name.ends_with(".json"))
        })
        .collect()
}

/// Drop a lock directory left behind by a process that died mid-write.
fn remove_abandoned_lock(lock_dir: &Path, ownerless_grace_ms: u64) -> bool {
    let Ok(metadata) = std::fs::metadata(lock_dir) else {
        // Already gone; the caller's next `mkdir` will win it.
        return true;
    };
    if !metadata.is_dir() {
        // A single-file lock from before the directory-based format. Reclaim it
        // on the same terms, and re-read to be sure it did not change under us.
        let Ok(before) = std::fs::read_to_string(lock_dir) else {
            return false;
        };
        if !is_owner_file_reclaimable(lock_dir, ownerless_grace_ms) {
            return false;
        }
        let after = std::fs::read_to_string(lock_dir).unwrap_or_default();
        if before != after {
            return false;
        }
        return std::fs::remove_file(lock_dir).is_ok();
    }

    let owners = owner_files(lock_dir);
    if owners.len() == 1 {
        // A single owner is the common case: check it and drop the whole
        // directory, which is atomic enough because nobody else can add an
        // owner to a directory they do not hold.
        if !is_owner_file_reclaimable(&owners[0], ownerless_grace_ms) {
            return false;
        }
        let _ = std::fs::remove_file(&owners[0]);
        return std::fs::remove_dir(lock_dir).is_ok();
    }
    if owners.len() > 1 {
        // Contended or mid-reclaim. Every owner must be dead before the
        // directory goes, or we would free a live writer's lock.
        if owners
            .iter()
            .any(|owner| !is_owner_file_reclaimable(owner, ownerless_grace_ms))
        {
            return false;
        }
        for owner in owners {
            let _ = std::fs::remove_file(owner);
        }
        return std::fs::remove_dir(lock_dir).is_ok();
    }
    // A lock directory with no owner file is either mid-acquire or orphaned.
    // The grace period keeps us from stealing it from a writer between
    // `mkdir` and its owner write.
    let Some(created_at) = file_mtime_ms(lock_dir, now_ms()) else {
        return false;
    };
    if now_ms().saturating_sub(created_at) < ownerless_grace_ms {
        return false;
    }
    std::fs::remove_dir(lock_dir).is_ok()
}

fn lock_timeout_error(file_path: &Path, lock_dir: &Path, waited_ms: u64) -> String {
    tracing::warn!(
        lock = %lock_dir.display(),
        waited_ms,
        "timed out waiting for the credential store file lock"
    );
    format!(
        "Timed out after {waited_ms}ms waiting for the ZCode file lock: {} ({FILE_LOCK_TIMEOUT_ERROR_CODE}: {})",
        lock_dir.display(),
        file_path.display()
    )
}

/// Hold an exclusive lock on `file_path` for the duration of `operation`.
///
/// Returns whatever `operation` returns. The lock is released on every exit
/// path, including a panic in `operation`, so a handler that fails cannot leave
/// the store locked against the other processes.
pub fn with_file_lock<T>(
    file_path: &Path,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let lock_dir = PathBuf::from(format!("{}.lock", file_path.display()));
    if let Some(parent) = lock_dir.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }

    // The original clamps the grace period to half the max wait, so a very
    // short timeout can never be entirely consumed by the grace check.
    let grace_ms = LOCK_OWNERLESS_GRACE_MS.min(LOCK_MAX_WAIT_MS / 2);
    let token = format!("{}-{}-{}", std::process::id(), now_ms(), random_hex(6));
    let owner_file = lock_dir.join(format!("owner-{token}.json"));
    let payload = format!(
        "{{\"pid\":{},\"createdAt\":{},\"token\":\"{token}\"}}\n",
        std::process::id(),
        now_ms()
    );

    let started_at = now_ms();
    let mut attempt = 0usize;
    loop {
        let mut created_lock = false;
        let attempt_result = (|| -> Result<(), std::io::Error> {
            // Non-recursive `mkdir` is the atomic exclusive create: it fails
            // with EEXIST for every other holder, in this or any other process.
            std::fs::create_dir(&lock_dir)?;
            created_lock = true;
            let mut file = open_new_private(&owner_file)?;
            file.write_all(payload.as_bytes())?;
            file.sync_all()?;

            // Re-verify ownership after writing it. Without this, a reclaim by
            // a concurrent waiter could have replaced the directory between our
            // `mkdir` and our owner write, and two processes would both believe
            // they hold the lock.
            let owners = owner_files(&lock_dir);
            if owners.len() != 1 || owners[0] != owner_file {
                return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
            }
            Ok(())
        })();

        match attempt_result {
            Ok(()) => {
                let release = || {
                    // Remove only our own owner file. If the lock was reclaimed
                    // while we held it, this leaves the new holder's file alone
                    // and the `remove_dir` fails harmlessly.
                    let _ = std::fs::remove_file(&owner_file);
                    let _ = std::fs::remove_dir(&lock_dir);
                };
                let result = operation();
                release();
                return result;
            }
            Err(error) => {
                if created_lock {
                    let _ = std::fs::remove_file(&owner_file);
                    let _ = std::fs::remove_dir(&lock_dir);
                }
                // A lock directory that vanished under us is contention we lost,
                // not a real failure; retry rather than surfacing it.
                let lost_created_lock =
                    created_lock && error.kind() == std::io::ErrorKind::NotFound;
                if !is_already_exists(&error) && !lost_created_lock {
                    return Err(format!(
                        "cannot acquire the ZCode file lock {}: {error}",
                        lock_dir.display()
                    ));
                }

                let elapsed_ms = now_ms().saturating_sub(started_at);
                if elapsed_ms >= LOCK_MAX_WAIT_MS {
                    return Err(lock_timeout_error(file_path, &lock_dir, elapsed_ms));
                }
                if remove_abandoned_lock(&lock_dir, grace_ms) {
                    continue;
                }
                let remaining_ms = LOCK_MAX_WAIT_MS.saturating_sub(elapsed_ms);
                let index = attempt.min(LOCK_RETRY_DELAYS_MS.len() - 1);
                let delay = LOCK_RETRY_DELAYS_MS[index].min(remaining_ms);
                std::thread::sleep(Duration::from_millis(delay));
                attempt += 1;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

fn rename_with_retry(temp: &Path, target: &Path) -> std::io::Result<()> {
    let delays = RENAME_RETRY_DELAYS_MS;
    let mut attempt = 0usize;
    loop {
        match std::fs::rename(temp, target) {
            Ok(()) => return Ok(()),
            Err(error) => {
                let Some(delay) = delays.get(attempt) else {
                    return Err(error);
                };
                if !is_retryable_rename_error(&error) {
                    return Err(error);
                }
                std::thread::sleep(Duration::from_millis(*delay));
                attempt += 1;
            }
        }
    }
}

/// Replace `file_path` with `content` such that a reader sees either the old
/// file or the new one, never a half-written one, and never a world-readable
/// one.
///
/// The temp name embeds the pid, a timestamp, and random bytes so that two
/// processes writing the same target cannot land on the same scratch file. A
/// fixed name would be a lost update waiting to happen: process A writes, B
/// writes, A renames B's bytes into place.
pub fn atomic_write_private_text_file(file_path: &Path, content: &str) -> Result<(), String> {
    let parent = file_path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;

    let base = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let temp = parent.join(format!(
        ".{base}.{}.{}.{}.tmp",
        std::process::id(),
        now_ms(),
        random_hex(6)
    ));

    let write_result = (|| -> std::io::Result<()> {
        let mut file = open_new_private(&temp)?;
        file.write_all(content.as_bytes())?;
        // Flush before the rename: without this, a crash can leave a
        // correctly-named file full of zeros, and the next reader treats it as
        // a corrupt store rather than as a clean missing one.
        file.sync_all()?;
        drop(file);
        rename_with_retry(&temp, file_path)
    })();

    if let Err(error) = write_result {
        // The temp file holds the entire secret store. Leaving it behind on a
        // partial write would strand it on disk at whatever mode the failed
        // open left it, outside the atomic replace that would have protected
        // it.
        let _ = std::fs::remove_file(&temp);
        return Err(format!("cannot write {}: {error}", file_path.display()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Corruption backup
// ---------------------------------------------------------------------------

/// Copy a damaged file aside and return the backup path, leaving the original
/// in place.
///
/// The original stays put **on purpose**. The store is only recoverable by
/// deleting it by hand, and the reason is that a damaged store must never be
/// silently replaced: the next `save` reads it, sees corruption, and fails
/// again. If a reader instead moved the file away, the following `save` would
/// find nothing, start from an empty map, and overwrite the file — destroying
/// every other session's login with no error and no way back.
///
/// The name is derived from the content hash so that Desktop, the CLI, and any
/// retry loop all converge on one piece of evidence instead of racing to
/// produce N near-identical copies.
pub fn backup_corrupt_file(file_path: &Path) -> Result<PathBuf, String> {
    let content = std::fs::read(file_path)
        .map_err(|error| format!("cannot read {}: {error}", file_path.display()))?;
    let content_id = hex_prefix(&Sha256::digest(&content), 24);
    let backup_path = PathBuf::from(format!("{}.corrupt-{content_id}.bak", file_path.display()));

    match open_new_private(&backup_path).and_then(|mut file| file.write_all(&content)) {
        Ok(()) => {}
        // Already backed up: same content, same name, so there is nothing to
        // add and no reason to fail the read that triggered this.
        Err(error) if is_already_exists(&error) => {}
        Err(error) => {
            return Err(format!("cannot back up {}: {error}", file_path.display()));
        }
    }
    // Set the mode even when the file already existed, because a copy made by
    // an older build may predate the private mode.
    set_owner_only(&backup_path)?;
    Ok(backup_path)
}

fn hex_prefix(bytes: &[u8], count: usize) -> String {
    bytes
        .iter()
        .take(count / 2)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(unix)]
pub fn set_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("cannot restrict permissions on {}: {error}", path.display()))
}

#[cfg(not(unix))]
pub fn set_owner_only(_path: &Path) -> Result<(), String> {
    // Windows inherits the profile directory's ACL; there is no POSIX mode, and
    // the create-time mode is likewise meaningless there.
    Ok(())
}
