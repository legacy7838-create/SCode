//! PTY lifecycle: spawn, streaming reader, exit watcher, and the incremental UTF-8 decoder.

use std::io::{ErrorKind, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

use crate::resolve;
use crate::{CreateOptions, PtyHandle, TERMINALS};

/// Data stream callback (raw UTF-8 chunk from the PTY master) using the `Fatal` error
/// strategy so the JS callback receives a single value argument (not `(err, value)`).
type DataFn = ThreadsafeFunction<String, ErrorStrategy::Fatal>;
/// Exit callback (child exit code), same single-argument convention as [`DataFn`].
type ExitFn = ThreadsafeFunction<i32, ErrorStrategy::Fatal>;

/// Spawn a shell and wire up the two background threads (reader + exit watcher).
///
/// Returns the resolved shell path on success; on failure the error message is shaped like
/// the old `Failed to start terminal with shell '<shell>' in '<cwd>': <cause>` wrapper.
pub fn create(
    opts: CreateOptions,
    on_data: DataFn,
    on_exit: ExitFn,
) -> std::result::Result<String, String> {
    let shell = resolve::resolve_shell().map_err(|e| e.to_string())?;
    let cwd = resolve::resolve_cwd(opts.cwd.as_deref()).map_err(|e| e.to_string())?;
    let env = resolve::resolve_env();

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: opts.rows,
        cols: opts.cols,
        pixel_width: 0,
        pixel_height: 0,
    });
    let pair = match pair {
        Ok(pair) => pair,
        Err(err) => {
            return Err(format!(
                "Failed to allocate PTY for shell '{shell}' in '{cwd}': {err}"
            ))
        }
    };

    // Clone the reader and take the writer *before* spawning so no early output is lost.
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("Failed to start terminal with shell '{shell}' in '{cwd}': {err}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("Failed to start terminal with shell '{shell}' in '{cwd}': {err}"))?;

    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);
    // Replace the environment wholesale (parity with node-pty passing a resolved env object).
    cmd.env_clear();
    for (k, v) in env {
        cmd.env(k, v);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|err| format!("Failed to start terminal with shell '{shell}' in '{cwd}': {err}"))?;

    // Split the child so `kill` never blocks behind the exit thread's `wait()`.
    let killer = child.clone_killer();
    let disposed = Arc::new(AtomicBool::new(false));

    let master_arc = Arc::new(std::sync::Mutex::new(pair.master));
    let writer_arc = Arc::new(std::sync::Mutex::new(writer));
    let killer_arc = Arc::new(std::sync::Mutex::new(killer));

    // Register before starting threads so a fast dispose is guaranteed to find the handle.
    // Best-effort: a poisoned lock here is unrecoverable, but never panics the host.
    if let Ok(mut map) = TERMINALS.lock() {
        map.insert(
            opts.id.clone(),
            PtyHandle {
                master: master_arc,
                writer: writer_arc,
                killer: killer_arc,
                disposed: disposed.clone(),
            },
        );
    }

    let id_for_exit = opts.id.clone();
    let disposed_for_reader = disposed.clone();
    // Reader thread: pumps PTY bytes through the incremental decoder into the data callback.
    let reader_thread = std::thread::spawn(move || {
        reader_loop(reader, on_data, disposed_for_reader);
    });

    let disposed_for_exit = disposed.clone();
    // Exit thread: waits on the child, then joins the reader to guarantee output is flushed
    // before the exit event fires (so the tab never closes with output left undelivered).
    std::thread::spawn(move || {
        let exit_code = match child.wait() {
            Ok(status) => Some(i32::try_from(status.exit_code()).unwrap_or(-1)),
            Err(_) => None,
        };
        let _ = reader_thread.join();
        if !disposed_for_exit.load(Ordering::SeqCst) {
            if let Some(code) = exit_code {
                on_exit.call(code, ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
        if let Ok(mut map) = TERMINALS.lock() {
            map.remove(&id_for_exit);
        }
    });

    Ok(shell)
}

/// Read the PTY master until EOF, decoding UTF-8 incrementally and emitting each decodable
/// chunk to the data callback. A trailing partial multibyte sequence is buffered until the
/// next read so CJK/emoji split across reads is never corrupted.
fn reader_loop(
    mut reader: Box<dyn Read + Send>,
    tsfn: DataFn,
    _disposed: Arc<AtomicBool>,
) {
    let mut buf = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                drain_decodable(&mut pending, &tsfn);
            }
            Err(ref err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    // Best-effort flush of any still-buffered trailing bytes on EOF.
    if !pending.is_empty() {
        let text = String::from_utf8_lossy(&pending).into_owned();
        tsfn.call(text, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

/// Emit every fully-decodable UTF-8 prefix from `pending`, leaving any trailing incomplete
/// multibyte sequence buffered for the next call.
fn drain_decodable(pending: &mut Vec<u8>, tsfn: &DataFn) {
    match std::str::from_utf8(pending) {
        Ok(valid) => {
            if !valid.is_empty() {
                tsfn.call(valid.to_string(), ThreadsafeFunctionCallMode::NonBlocking);
            }
            pending.clear();
        }
        Err(err) => match err.error_len() {
            // Incomplete trailing sequence: emit the valid prefix, keep the remainder.
            None => {
                let valid_up_to = err.valid_up_to();
                if valid_up_to > 0 {
                    let s = std::str::from_utf8(&pending[..valid_up_to])
                        .expect("valid_up_to always marks a valid UTF-8 prefix")
                        .to_string();
                    tsfn.call(s, ThreadsafeFunctionCallMode::NonBlocking);
                    pending.drain(..valid_up_to);
                }
            }
            // A genuinely invalid byte: emit the valid prefix, substitute one U+FFFD,
            // drop the offending byte sequence, and keep scanning (lossy parity).
            Some(bad_len) => {
                let valid_up_to = err.valid_up_to();
                if valid_up_to > 0 {
                    let s = String::from_utf8_lossy(&pending[..valid_up_to]).into_owned();
                    tsfn.call(s, ThreadsafeFunctionCallMode::NonBlocking);
                    pending.drain(..valid_up_to);
                }
                tsfn.call(
                    "\u{FFFD}".to_string(),
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
                pending.drain(..bad_len);
            }
        },
    }
}

#[cfg(test)]
mod tests {
    // The decoder is exercised without a real PTY callback by asserting on the split logic
    // directly through a Vec-based helper that mirrors `drain_decodable`'s branching.
    fn split_at_incomplete(bytes: &[u8]) -> (Vec<u8>, Vec<u8>) {
        match std::str::from_utf8(bytes) {
            Ok(_) => (bytes.to_vec(), Vec::new()),
            Err(err) => match err.error_len() {
                None => (bytes[..err.valid_up_to()].to_vec(), bytes[err.valid_up_to()..].to_vec()),
                Some(bad_len) => {
                    let mut consumed = bytes[..err.valid_up_to() + bad_len].to_vec();
                    let rest = bytes[err.valid_up_to() + bad_len..].to_vec();
                    consumed.truncate(err.valid_up_to());
                    (consumed, rest)
                }
            },
        }
    }

    #[test]
    fn complete_multibyte_is_wholly_decodable() {
        // "é" U+00E9 (2 bytes) + "你" U+4F60 (3 bytes), all complete.
        let data = "é你".as_bytes().to_vec();
        let (consumed, rest) = split_at_incomplete(&data);
        assert_eq!(consumed, data);
        assert!(rest.is_empty());
    }

    #[test]
    fn split_codepoint_buffers_the_incomplete_tail() {
        // Feed "你" then split its 3 bytes across two reads.
        let full = "你".as_bytes().to_vec();
        let (first, pending) = split_at_incomplete(&full[..2]);
        // The first two bytes are an incomplete leading sequence: nothing decodable yet.
        assert!(first.is_empty(), "must not emit a partial codepoint");
        assert_eq!(pending.len(), 2);
        // Rejoin and it decodes fully.
        let rejoined = [pending.as_slice(), &full[2..]].concat();
        let (consumed, rest) = split_at_incomplete(&rejoined);
        assert_eq!(std::str::from_utf8(&consumed).unwrap(), "你");
        assert!(rest.is_empty());
    }

    #[test]
    fn ascii_prefix_then_incomplete_cjk() {
        // "hi你" but only the first 4 of 5 bytes arrive (truncated CJK tail).
        let bytes = b"hi\xE4\xBD".to_vec();
        let (consumed, rest) = split_at_incomplete(&bytes);
        assert_eq!(std::str::from_utf8(&consumed).unwrap(), "hi");
        assert_eq!(rest.len(), 2, "the incomplete CJK lead bytes stay buffered");
    }
}
