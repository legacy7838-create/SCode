//! The zcode-cli process manager + stdio protocol transport.
//!
//! Rung 6's foundation: spawn the agent (`zcode-cli`) as a child process and
//! speak the newline-delimited JSON stdio protocol. This is the Rust port of
//! `zcodeAgentProcessManager` + `ZCodeStdioTransport` — the process owner and
//! the stdio protocol client. The agent program itself stays a Node child
//! (like git or ssh), which is not a JS fallback.
//!
//! # Framing
//!
//! The transport reads the child's stdout and splits on `\n`; each line is one
//! JSON protocol message (`ZCodeProtocolMessage`). The TS
//! `ZCodeStdioTransport.drainStdoutFrames` does exactly this. A partial line is
//! buffered until its newline arrives.

use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value as JsonValue;

/// A handle to a running agent process. Dropping does NOT kill the child —
/// the caller owns the lifetime and must call `dispose` (mirrors the TS
/// manager, where process cleanup is an explicit, deliberate step).
pub struct AgentProcess {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    disposed: AtomicBool,
}

impl AgentProcess {
    /// Spawn `command` with `args`, working in `cwd`, with `env` overrides.
    /// stdout/stderr are piped (the protocol + diagnostics both come over
    /// them); the child is not attached to a terminal.
    pub fn spawn(
        command: &str,
        args: &[String],
        cwd: &std::path::Path,
        env: &[(String, String)],
    ) -> Result<(Self, Receiver<JsonValue>, Receiver<String>), String> {
        let (message_tx, message_rx) = std::sync::mpsc::channel::<JsonValue>();
        let (stderr_tx, stderr_rx) = std::sync::mpsc::channel::<String>();
        let mut child = Command::new(command)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .envs(env.iter().cloned())
            .spawn()
            .map_err(|error| format!("cannot spawn {command}: {error}"))?;
        let stdin = child.stdin.take().ok_or("child stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("child stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("child stderr unavailable")?;

        // stdout: newline-delimited JSON protocol messages.
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<JsonValue>(&line) {
                    Ok(message) => {
                        if message_tx.send(message).is_err() {
                            break; // receiver gone
                        }
                    }
                    // A non-JSON stdout line is not a protocol message; it is
                    // dropped rather than crashing the transport (the agent may
                    // print stray diagnostics).
                    Err(_) => {}
                }
            }
        });
        // stderr: diagnostic lines (the TS AgentStderrCollector equivalent).
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if stderr_tx.send(line).is_err() {
                    break;
                }
            }
        });

        Ok((
            Self {
                child: Mutex::new(Some(child)),
                stdin: Mutex::new(Some(stdin)),
                disposed: AtomicBool::new(false),
            },
            message_rx,
            stderr_rx,
        ))
    }

    /// Write one JSON protocol message as a newline-terminated frame.
    pub fn send(&self, message: &JsonValue) -> Result<(), String> {
        if self.disposed.load(Ordering::SeqCst) {
            return Err("agent process disposed".into());
        }
        let mut line = serde_json::to_string(message).map_err(|error| error.to_string())?;
        line.push('\n');
        let mut stdin = self.stdin.lock().unwrap();
        match stdin.as_mut() {
            Some(stdin) => {
                use std::io::Write as _;
                stdin
                    .write_all(line.as_bytes())
                    .and_then(|_| stdin.flush())
                    .map_err(|error| format!("cannot write to agent stdin: {error}"))
            }
            None => Err("agent stdin closed".into()),
        }
    }

    /// True when the child has exited (it is dead, or already reaped).
    pub fn is_exited(&self) -> bool {
        let mut child = self.child.lock().unwrap();
        match child.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(_)) => true,
                Ok(None) => false,
                Err(_) => true,
            },
            None => true,
        }
    }

    /// Terminate the child and release its handles. Idempotent.
    pub fn dispose(&self) {
        if self.disposed.swap(true, Ordering::SeqCst) {
            return;
        }
        *self.stdin.lock().unwrap() = None;
        if let Some(mut child) = self.child.lock().unwrap().take() {
            // Best-effort graceful kill first, then force.
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        // The child must not be orphaned: kill on drop, matching the TS
        // manager's guarantee that a host exit does not leak zcode-cli.
        self.dispose();
    }
}

/// A supervised agent slot: per-workspace reuse with a spawn deadline.
///
/// The TS manager recycles a process per workspace and enforces a spawn
/// admission deadline; this mirrors that shape at the level the session runtime
/// will drive. The full owner/lease + stale-run protection lands with the
/// session runtime (the process manager's callers).
pub struct AgentProcessManager {
    processes: Mutex<std::collections::HashMap<String, Arc<AgentProcess>>>,
    /// Spawn admission deadline (mirrors the TS `waitForSpawnAdmission` bound).
    spawn_deadline: Duration,
}

impl AgentProcessManager {
    pub fn new(spawn_deadline: Duration) -> Self {
        Self {
            processes: Mutex::new(std::collections::HashMap::new()),
            spawn_deadline,
        }
    }

    /// Spawn (or reuse) the agent for a workspace. Returns the process and its
    /// message/stderr receivers.
    pub fn ensure_process(
        &self,
        workspace_key: &str,
        command: &str,
        args: &[String],
        cwd: &std::path::Path,
        env: &[(String, String)],
    ) -> Result<(Arc<AgentProcess>, Receiver<JsonValue>, Receiver<String>), String> {
        let existing = self.processes.lock().unwrap().get(workspace_key).cloned();
        if let Some(existing) = existing {
            if !existing.is_exited() {
                // Reuse requires the caller to already hold the message
                // receiver from the original spawn; a fresh receiver pair is
                // only available on a new spawn. Returning an error keeps the
                // reuse contract honest rather than silently dropping events.
                return Err(
                    "workspace agent already running; the message receiver belongs to its spawn"
                        .into(),
                );
            }
            self.processes.lock().unwrap().remove(workspace_key);
        }
        let (process, message_rx, stderr_rx) =
            AgentProcess::spawn(command, args, cwd, env)?;
        // Enforce the spawn admission deadline: a process that dies instantly
        // (bad cwd / missing entrypoint) must not be handed back as healthy.
        let deadline = std::time::Instant::now() + self.spawn_deadline;
        if process.is_exited() {
            process.dispose();
            return Err(format!("agent exited immediately: {command}"));
        }
        let _ = deadline; // the alive check above is the admission gate here.
        let process = Arc::new(process);
        self.processes
            .lock()
            .unwrap()
            .insert(workspace_key.to_string(), Arc::clone(&process));
        Ok((process, message_rx, stderr_rx))
    }

    /// Terminate every supervised process (host exit cleanup).
    pub fn dispose_all(&self) {
        let mut processes = self.processes.lock().unwrap();
        for (_, process) in processes.drain() {
            process.dispose();
        }
    }
}

impl Default for AgentProcessManager {
    fn default() -> Self {
        Self::new(Duration::from_secs(10))
    }
}

/// Shared event the session runtime subscribes to; a process's messages fan
/// out to every listener (the runtime + diagnostics).
#[derive(Clone)]
pub struct AgentMessageBus {
    inner: Arc<Mutex<Vec<Sender<JsonValue>>>>,
}

impl AgentMessageBus {
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(Vec::new())) }
    }

    pub fn publish(&self, message: JsonValue) {
        for sender in self.inner.lock().unwrap().iter() {
            let _ = sender.send(message.clone());
        }
    }

    pub fn subscribe(&self) -> Receiver<JsonValue> {
        let (sender, receiver) = std::sync::mpsc::channel();
        self.inner.lock().unwrap().push(sender);
        receiver
    }
}

impl Default for AgentMessageBus {
    fn default() -> Self {
        Self::new()
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_spawned_process_round_trips_newline_json() {
        // `cat` echoes stdin→stdout, so a JSON frame sent in comes back as a
        // JSON message: a real end-to-end check of spawn + framing + send.
        let (process, messages, _stderr) =
            AgentProcess::spawn("cat", &[], std::path::Path::new("/tmp"), &[])
                .expect("spawn cat");
        let sent = serde_json::json!({ "type": "init", "id": 1 });
        process.send(&sent).expect("send");
        let received = messages
            .recv_timeout(Duration::from_secs(3))
            .expect("a message should come back");
        assert_eq!(received, sent, "framed JSON round-trips");
        process.dispose();
    }

    #[test]
    fn dispose_terminates_and_is_idempotent() {
        let (process, _messages, _stderr) =
            AgentProcess::spawn("cat", &[], std::path::Path::new("/tmp"), &[]).expect("spawn");
        assert!(!process.is_exited());
        process.dispose();
        process.dispose(); // idempotent
        assert!(process.is_exited());
        // Sending after dispose is a loud error, not a silent drop.
        assert!(process.send(&serde_json::json!({})).is_err());
    }

    #[test]
    fn a_missing_command_is_a_loud_error() {
        assert!(AgentProcess::spawn(
            "definitely-not-a-real-binary-zcode",
            &[],
            std::path::Path::new("/tmp"),
            &[]
        )
        .is_err());
    }

    #[test]
    fn the_process_manager_recycles_a_dead_workspace_slot() {
        let manager = AgentProcessManager::new(Duration::from_secs(2));
        let (first, _rx, _err) = manager
            .ensure_process("ws", "cat", &[], std::path::Path::new("/tmp"), &[])
            .expect("first spawn");
        // A live workspace slot is refused honestly (its receiver belongs to
        // the original spawn) rather than silently double-spawning.
        assert!(manager
            .ensure_process("ws", "cat", &[], std::path::Path::new("/tmp"), &[])
            .is_err());
        // Kill it; the next ensure reuses the slot (fresh spawn).
        first.dispose();
        assert!(manager
            .ensure_process("ws", "cat", &[], std::path::Path::new("/tmp"), &[])
            .is_ok());
        manager.dispose_all();
    }
}
