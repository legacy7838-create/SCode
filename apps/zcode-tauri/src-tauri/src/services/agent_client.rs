//! The agent request/response client — session-runtime core.
//!
//! Rung 6's correlation layer: send a typed protocol request to a running
//! agent and await the response with the matching id. This is the Rust
//! equivalent of the TS `ZCodeAgentService`'s `client.request(...)`. It sits on
//! the process manager (spawn/framing) and the protocol validation (decode).
//!
//! # Correlation
//!
//! Every request gets a unique numeric id; the client waits for the response
//! whose `id` matches, routing notifications to a listener and discarding
//! unrelated responses. A timeout is a loud error, never a silent hang.

use std::collections::HashMap;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value as JsonValue;

use crate::services::agent_process::AgentProcess;
use crate::services::zcode_protocol::{decode_protocol_message, encode_request, ProtocolId, ProtocolMessage};

/// A pending in-flight request awaiting its response.
struct Pending {
    result: Mutex<Option<Result<JsonValue, String>>>,
    done: std::sync::Condvar,
}

pub struct AgentClient {
    process: Arc<AgentProcess>,
    next_id: Mutex<i64>,
    pending: Mutex<HashMap<i64, Arc<Pending>>>,
    notifications: Mutex<Vec<Box<dyn Fn(&str, Option<&JsonValue>) + Send + Sync>>>,
}

impl AgentClient {
    /// Drive the client from the process's message stream. The reader thread
    /// decodes each frame and routes responses to waiters, notifications to
    /// listeners.
    pub fn new(process: Arc<AgentProcess>, messages: Receiver<JsonValue>) -> Arc<Self> {
        let client = Arc::new(Self {
            process,
            next_id: Mutex::new(1),
            pending: Mutex::new(HashMap::new()),
            notifications: Mutex::new(Vec::new()),
        });
        let reader = Arc::clone(&client);
        std::thread::spawn(move || {
            while let Ok(raw) = messages.recv() {
                let Ok(message) = decode_protocol_message(&raw) else {
                    continue; // not a protocol message; the transport drops it
                };
                match message {
                    ProtocolMessage::Response { id, result } => {
                        if let ProtocolId::Number(id) = id {
                            if let Some(pending) = reader.pending.lock().unwrap().remove(&id) {
                                *pending.result.lock().unwrap() = Some(Ok(result));
                                pending.done.notify_all();
                            }
                        }
                    }
                    ProtocolMessage::Error { id, code, message, .. } => {
                        if let ProtocolId::Number(id) = id {
                            if let Some(pending) = reader.pending.lock().unwrap().remove(&id) {
                                *pending.result.lock().unwrap() =
                                    Some(Err(format!("agent error {code}: {message}")));
                                pending.done.notify_all();
                            }
                        }
                    }
                    ProtocolMessage::Notification { method, params } => {
                        for listener in reader.notifications.lock().unwrap().iter() {
                            listener(&method, params.as_ref());
                        }
                    }
                    // A request from the agent (a tool call etc.) is the session
                    // runtime's business; it is not a response to our request.
                    ProtocolMessage::Request { .. } => {}
                }
            }
        });
        client
    }

    /// Subscribe to agent notifications (tool events, state changes).
    pub fn on_notification(&self, listener: impl Fn(&str, Option<&JsonValue>) + Send + Sync + 'static) {
        self.notifications.lock().unwrap().push(Box::new(listener));
    }

    /// Send a request and await its response. `timeout` bounds the wait; a
    /// timeout is a loud error, never a silent hang.
    pub fn request(
        &self,
        method: &str,
        params: Option<&JsonValue>,
        timeout: Duration,
    ) -> Result<JsonValue, String> {
        let id = {
            let mut next = self.next_id.lock().unwrap();
            let id = *next;
            *next += 1;
            id
        };
        let pending = Arc::new(Pending {
            result: Mutex::new(None),
            done: std::sync::Condvar::new(),
        });
        self.pending
            .lock()
            .unwrap()
            .insert(id, Arc::clone(&pending));
        let frame = encode_request(ProtocolId::Number(id), method, params)?;
        // Write the raw frame (already newline-free JSON + newline added by send).
        self.process.send(&serde_json::from_str::<JsonValue>(&frame).map_err(|e| e.to_string())?)?;

        let deadline = Instant::now() + timeout;
        let mut result = pending.result.lock().unwrap();
        loop {
            if let Some(result) = result.take() {
                self.pending.lock().unwrap().remove(&id);
                return result;
            }
            let now = Instant::now();
            if now >= deadline {
                self.pending.lock().unwrap().remove(&id);
                return Err(format!("agent request `{method}` timed out"));
            }
            let (guard, timeout_result) = pending
                .done
                .wait_timeout(result, deadline - now)
                .map_err(|_| "request wait poisoned".to_string())?;
            result = guard;
            if timeout_result.timed_out() && result.is_none() {
                self.pending.lock().unwrap().remove(&id);
                return Err(format!("agent request `{method}` timed out"));
            }
        }
    }

    /// Terminate the underlying agent.
    pub fn dispose(&self) {
        self.process.dispose();
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    /// A fake agent: reads newline-JSON requests on stdin and replies to each
    /// with a response carrying the same id. Exercises the real correlation.
    fn spawn_fake_agent(script: &str) -> (AgentProcess, Receiver<JsonValue>, Receiver<String>) {
        AgentProcess::spawn(
            "node",
            &["-e".to_string(), script.to_string()],
            std::path::Path::new("/tmp"),
            &[],
        )
        .expect("spawn fake agent")
    }

    const FAKE_AGENT: &str = r#"
      const readline = require("readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const req = JSON.parse(line);
        const result = req.method === "session/list"
          ? { sessions: [{ sessionId: "s1" }, { sessionId: "s2" }] }
          : { ok: true };
        process.stdout.write(JSON.stringify({ id: req.id, result }) + "\n");
      });
    "#;

    #[test]
    fn a_request_awaits_its_matching_response() {
        let (process, messages, _stderr) = spawn_fake_agent(FAKE_AGENT);
        let client = AgentClient::new(Arc::new(process), messages);
        let result = client
            .request("session/list", Some(&serde_json::json!({ "workspace": { "path": "/ws" } })), Duration::from_secs(3))
            .expect("request");
        assert_eq!(result["sessions"].as_array().map(Vec::len), Some(2), "sessions: {result}");
        client.dispose();
    }

    #[test]
    fn a_timeout_is_a_loud_error_not_a_hang() {
        // A silent agent (never responds) → the request times out loudly.
        let (process, messages, _stderr) = spawn_fake_agent("process.stdin.resume();");
        let client = AgentClient::new(Arc::new(process), messages);
        let error = client
            .request("session/list", None, Duration::from_millis(300))
            .expect_err("must time out");
        assert!(error.contains("timed out"), "{error}");
        client.dispose();
    }

    #[test]
    fn an_unknown_method_still_gets_a_response() {
        let (process, messages, _stderr) = spawn_fake_agent(FAKE_AGENT);
        let client = AgentClient::new(Arc::new(process), messages);
        let result = client.request("anything", None, Duration::from_secs(3)).expect("request");
        assert_eq!(result["ok"], serde_json::json!(true));
        client.dispose();
    }
}
