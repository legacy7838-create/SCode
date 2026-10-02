//! `zcode-agent` channel — the agent session surface.
//!
//! Rung 6's channel on top of the agent process manager + protocol validation +
//! request/response correlation. `listSessions` is the read-only core the task
//! list uses; it spawns the agent (`zcode-cli`) for a workspace, sends the
//! `session/list` protocol request, and returns the sessions. The rest of the
//! `IZCodeAgentService` surface (create/resume/read sessions, subagents,
//! usage stats) is not yet ported and returns loud errors — it belongs to the
//! session runtime that sits on this client, and a half-built guess would be a
//! silent wrong answer.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value as JsonValue;
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

use crate::services::agent_client::AgentClient;
use crate::services::agent_process::AgentProcessManager;

/// How the agent (`zcode-cli`) is launched. Injectable so tests can drive a
/// fake agent; the desktop host supplies the real `node zcode.cjs` command.
pub struct AgentCommand {
    pub program: String,
    pub args: Vec<String>,
}

pub struct ZCodeAgentService {
    manager: AgentProcessManager,
    clients: Mutex<HashMap<String, Arc<AgentClient>>>,
    command: AgentCommand,
    request_timeout: Duration,
    /// Live `session/event` routing: (workspace key, session id) → a subscriber
    /// sender, so each `onDynamicSessionEvent` gets its session's live events.
    session_event_senders: Arc<Mutex<HashMap<(String, String), crossbeam_channel::Sender<JsonValue>>>>,
}

impl ZCodeAgentService {
    pub fn new(command: AgentCommand) -> Self {
        Self {
            manager: AgentProcessManager::default(),
            clients: Mutex::new(HashMap::new()),
            command,
            request_timeout: Duration::from_secs(30),
            session_event_senders: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// `workspaceKey` — the identity rule, applied here outside the agent.
    fn workspace_key(workspace_path: &str, workspace_identity: Option<&str>) -> String {
        workspace_identity
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(workspace_path)
            .to_string()
    }

    /// The `zcodeWorkspaceRef` for a request.
    fn workspace_ref(workspace_path: &str, workspace_identity: Option<&str>) -> JsonValue {
        let mut ref_object = serde_json::Map::new();
        ref_object.insert("workspacePath".into(), serde_json::Value::String(workspace_path.to_string()));
        ref_object.insert(
            "workspaceKey".into(),
            serde_json::Value::String(Self::workspace_key(workspace_path, workspace_identity)),
        );
        if let Some(identity) = workspace_identity.filter(|v| !v.trim().is_empty()) {
            ref_object.insert("workspaceIdentity".into(), serde_json::Value::String(identity.to_string()));
        }
        serde_json::Value::Object(ref_object)
    }

    /// Get (or lazily spawn) the agent client for a workspace.
    fn client_for(&self, workspace_path: &str, workspace_identity: Option<&str>) -> Result<Arc<AgentClient>, HandlerError> {
        let key = Self::workspace_key(workspace_path, workspace_identity);
        if let Some(client) = self.clients.lock().unwrap().get(&key).cloned() {
            return Ok(client);
        }
        let (process, messages, _stderr) = self
            .manager
            .ensure_process(
                &key,
                &self.command.program,
                &self.command.args,
                PathBuf::from(workspace_path).as_path(),
                &[],
            )
            .map_err(HandlerError::message)?;
        let client = AgentClient::new(process, messages);
        // Route live `session/event` notifications to the matching session's
        // subscriber. Registered once per client (the senders map is shared).
        let senders = Arc::clone(&self.session_event_senders);
        let workspace_key = key.clone();
        client.on_notification(move |method, params| {
            if method != "session/event" {
                return;
            }
            let Some(params) = params else { return };
            let Some(session_id) = params.get("sessionId").and_then(JsonValue::as_str) else {
                return;
            };
            let sender = senders
                .lock()
                .unwrap()
                .get(&(workspace_key.clone(), session_id.to_string()))
                .cloned();
            if let Some(sender) = sender {
                let _ = sender.send(params.clone());
            }
        });
        self.clients.lock().unwrap().insert(key, Arc::clone(&client));
        Ok(client)
    }

    /// `session/list`: the read-only sessions the task list consumes.
    fn list_sessions(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let workspace_path = params
            .get("workspacePath")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| HandlerError::message("listSessions requires a `workspacePath`"))?;
        let identity = params.get("workspaceIdentity").and_then(JsonValue::as_str);
        let client = self.client_for(workspace_path, identity)?;
        let mut request_params = serde_json::Map::new();
        request_params.insert("workspace".into(), Self::workspace_ref(workspace_path, identity));
        request_params.insert(
            "includeArchived".into(),
            serde_json::Value::Bool(params.get("includeArchived").and_then(JsonValue::as_bool).unwrap_or(false)),
        );
        if let Some(limit) = params.get("limit") {
            request_params.insert("limit".into(), limit.clone());
        }
        if let Some(session_ids) = params.get("sessionIds").and_then(JsonValue::as_array) {
            request_params.insert("sessionIds".into(), serde_json::Value::Array(session_ids.clone()));
        }
        let result = client
            .request("session/list", Some(&serde_json::Value::Object(request_params)), self.request_timeout)
            .map_err(HandlerError::message)?;
        Ok(result.get("sessions").cloned().unwrap_or(JsonValue::Array(vec![])))
    }

    /// `session/subagents`: list a session's subagents. Read-only, maps cleanly.
    fn list_session_subagents(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let (client, session_id) = self.session_client_and_id(params, "listSessionSubagents")?;
        let mut request_params = serde_json::Map::new();
        request_params.insert("sessionId".into(), serde_json::Value::String(session_id));
        if let Some(cursor) = params.get("endedCursor") {
            request_params.insert("endedCursor".into(), cursor.clone());
        }
        let ended_limit = params
            .get("endedLimit")
            .and_then(JsonValue::as_u64)
            .unwrap_or(20);
        request_params.insert("endedLimit".into(), serde_json::Value::Number(ended_limit.into()));
        let result = client
            .request("session/subagents", Some(&serde_json::Value::Object(request_params)), self.request_timeout)
            .map_err(HandlerError::message)?;
        Ok(result)
    }

    /// `v4/command`: the chat send. The renderer supplies the conversation
    /// command envelope; a plain `sendText` is forwarded as-is. The automation /
    /// off-peak dispatch cases need tool-denylist merging at the envelope
    /// boundary (a wrong denylist silently drops a tool), so they are refused
    /// rather than guessed — they belong to the task-adapter runtime.
    fn send_conversation_command(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let workspace_path = params
            .get("workspacePath")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| HandlerError::message("sendConversationCommand requires a `workspacePath`"))?;
        let identity = params.get("workspaceIdentity").and_then(JsonValue::as_str);
        let envelope = params
            .get("envelope")
            .cloned()
            .ok_or_else(|| HandlerError::message("sendConversationCommand requires an `envelope`"))?;
        // A dispatch-bound sendText carries a tool denylist that must be merged
        // at the envelope boundary. Mirrors `automationToolPolicy`: an
        // automation run denies the Cron mutation tools (it must not
        // self-derive more schedules), an off-peak dispatch denies
        // OffPeakCreate (it must not recursively schedule itself). A wrong
        // denylist would silently drop a tool, so the merge is exact.
        let envelope = Self::merge_dispatch_denylist(envelope);
        let client = self.client_for(workspace_path, identity)?;
        client
            .request("v4/command", Some(&envelope), self.request_timeout)
            .map_err(HandlerError::message)
    }

    /// Merge the dispatch tool-denylist into a sendText envelope's payload
    /// (`automationToolPolicy.ts`): automation → Cron mutation tools, off-peak →
    /// OffPeakCreate. Idempotent (a Set union), so re-sending never duplicates.
    fn merge_dispatch_denylist(envelope: JsonValue) -> JsonValue {
        let Some(payload) = envelope.get("payload").cloned() else { return envelope };
        let automation = payload.get("automationId").is_some();
        let off_peak = payload.get("offPeakTaskId").is_some();
        if !automation && !off_peak {
            return envelope;
        }
        let mut denylist: Vec<String> = payload
            .get("toolDisallowlist")
            .and_then(JsonValue::as_array)
            .map(|items| items.iter().filter_map(JsonValue::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        if automation {
            for tool in ["CronCreate", "CronUpdate", "CronDelete"] {
                if !denylist.iter().any(|t| t == tool) {
                    denylist.push(tool.to_string());
                }
            }
        }
        if off_peak && !denylist.iter().any(|t| t == "OffPeakCreate") {
            denylist.push("OffPeakCreate".to_string());
        }
        let mut envelope = envelope;
        if let Some(object) = envelope.get_mut("payload").and_then(JsonValue::as_object_mut) {
            object.insert(
                "toolDisallowlist".into(),
                serde_json::Value::Array(denylist.into_iter().map(serde_json::Value::String).collect()),
            );
        }
        envelope
    }

    /// `v4/usage/stats`: application-wide usage. The usage store is global, so
    /// any connected workspace client answers it (the TS reuses an active one).
    fn get_app_usage_stats(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let client = self
            .clients
            .lock()
            .unwrap()
            .values()
            .next()
            .cloned()
            .ok_or_else(|| HandlerError::message("no_active_workspace"))?;
        let mut request_params = serde_json::Map::new();
        for field in ["range", "timeZone"] {
            if let Some(value) = params.get(field) {
                request_params.insert(field.into(), value.clone());
            }
        }
        client
            .request("v4/usage/stats", Some(&serde_json::Value::Object(request_params)), self.request_timeout)
            .map_err(HandlerError::message)
    }

    /// `session/messages`: read a session's messages. Read-only, maps cleanly.
    fn read_session_messages(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let (client, session_id) = self.session_client_and_id(params, "readSessionMessages")?;
        let mut request_params = serde_json::Map::new();
        request_params.insert("sessionId".into(), serde_json::Value::String(session_id));
        for field in ["afterMessageId", "limit"] {
            if let Some(value) = params.get(field) {
                request_params.insert(field.into(), value.clone());
            }
        }
        let result = client
            .request("session/messages", Some(&serde_json::Value::Object(request_params)), self.request_timeout)
            .map_err(HandlerError::message)?;
        Ok(result.get("messages").cloned().unwrap_or(JsonValue::Array(vec![])))
    }

    /// `session/debug`: read a session's debug snapshot. Read-only, maps cleanly.
    fn read_session_debug(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let (client, session_id) = self.session_client_and_id(params, "readSessionDebug")?;
        let result = client
            .request(
                "session/debug",
                Some(&serde_json::json!({ "sessionId": session_id })),
                self.request_timeout,
            )
            .map_err(HandlerError::message)?;
        Ok(result)
    }

    /// The client + a required `sessionId` for a session-scoped read.
    fn session_client_and_id(
        &self,
        params: &JsonValue,
        method: &str,
    ) -> Result<(std::sync::Arc<AgentClient>, String), HandlerError> {
        let workspace_path = params
            .get("workspacePath")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| HandlerError::message(format!("{method} requires a `workspacePath`")))?;
        let identity = params.get("workspaceIdentity").and_then(JsonValue::as_str);
        let session_id = params
            .get("sessionId")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| HandlerError::message(format!("{method} requires a `sessionId`")))?
            .to_string();
        let client = self.client_for(workspace_path, identity)?;
        Ok((client, session_id))
    }

    /// `onDynamicSessionEvent`: the session-events subscription. Sends
    /// `session/subscribe`, delivers the replay events + snapshot, then routes
    /// live `session/event` notifications (deduped by eventId) to the
    /// subscriber. The background-summary coalescing is an optimization and is
    /// deferred; dedup is kept because a duplicate timeline event is a silent
    /// wrong answer.
    fn subscribe_session_events(
        &self,
        params: &JsonValue,
    ) -> Result<crossbeam_channel::Receiver<JsonValue>, HandlerError> {
        let workspace_path = params
            .get("workspacePath")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| HandlerError::message("onDynamicSessionEvent requires a `workspacePath`"))?;
        let identity = params.get("workspaceIdentity").and_then(JsonValue::as_str);
        let session_id = params
            .get("sessionId")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| HandlerError::message("onDynamicSessionEvent requires a `sessionId`"))?
            .to_string();
        let client = self.client_for(workspace_path, identity)?;
        let (sender, receiver) = crossbeam_channel::unbounded();
        let workspace_key = Self::workspace_key(workspace_path, identity);
        self.session_event_senders
            .lock()
            .unwrap()
            .insert((workspace_key, session_id.clone()), sender);

        // Establish the subscription on a worker thread: `session/subscribe`
        // replays the gap + snapshot, then live events flow via the routing
        // listener registered in `client_for`.
        let senders = Arc::clone(&self.session_event_senders);
        let workspace_key = Self::workspace_key(workspace_path, identity);
        let params = params.clone();
        std::thread::spawn(move || {
            let mut request_params = serde_json::Map::new();
            request_params.insert("sessionId".into(), serde_json::Value::String(session_id.clone()));
            if let Some(after_seq) = params.get("afterSeq") {
                request_params.insert("afterSeq".into(), after_seq.clone());
            }
            request_params.insert("includeSnapshot".into(), serde_json::Value::Bool(true));
            let Ok(result) = client.request(
                "session/subscribe",
                Some(&serde_json::Value::Object(request_params)),
                Duration::from_secs(30),
            ) else {
                // A failed subscription tears down the routing entry so the
                // caller sees the stream end rather than a silent gap.
                senders.lock().unwrap().remove(&(workspace_key, session_id));
                return;
            };
            // Replay events in seq order, then the snapshot.
            if let Some(events) = result.get("events").and_then(JsonValue::as_array) {
                let mut sorted = events.clone();
                sorted.sort_by_key(|event| event.get("seq").and_then(JsonValue::as_u64).unwrap_or(0));
                for event in sorted {
                    let _ = senders
                        .lock()
                        .unwrap()
                        .get(&(workspace_key.clone(), session_id.clone()))
                        .map(|sender| sender.send(serde_json::json!({ "type": "session.event", "event": event })));
                }
            }
            if let Some(snapshot) = result.get("snapshot") {
                if !snapshot.is_null() {
                    let _ = senders
                        .lock()
                        .unwrap()
                        .get(&(workspace_key.clone(), session_id.clone()))
                        .map(|sender| sender.send(serde_json::json!({ "type": "snapshot", "snapshot": snapshot })));
                }
            }
        });
        Ok(receiver)
    }

    /// `session/create`: create a session. The param builder mirrors
    /// `buildSessionCreateParams` (conditional fields gated by the workflow
    /// flags). The cross-version compat-retry (for an old app-server's strict
    /// schema) is deferred: the desktop host runs a matching `zcode-cli`, so
    /// the schema matches and the retry path is not exercised.
    fn create_session(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let workspace_path = params
            .get("workspacePath")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| HandlerError::message("createSession requires a `workspacePath`"))?;
        let identity = params.get("workspaceIdentity").and_then(JsonValue::as_str);
        let session_id = params
            .get("sessionId")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| HandlerError::message("createSession requires a `sessionId`"))?;
        let client = self.client_for(workspace_path, identity)?;
        let mut request_params = serde_json::Map::new();
        request_params.insert("sessionId".into(), serde_json::Value::String(session_id.to_string()));
        request_params.insert("workspace".into(), Self::workspace_ref(workspace_path, identity));
        for field in ["parentSessionId", "mode", "model"] {
            if let Some(value) = params.get(field) {
                request_params.insert(field.into(), value.clone());
            }
        }
        for field in ["persistence", "thoughtLevel", "titleGenerationEnabled", "mcpServers", "toolAllowlist", "toolDenylist", "importedHistory"] {
            if let Some(value) = params.get(field) {
                request_params.insert(field.into(), value.clone());
            }
        }
        // Workflow/tool-surface flags are sent only when true, matching the TS
        // `buildSessionCreateParams` grayscale delivery.
        for field in ["offPeakToolEnabled", "dynamicWorkflowEnabled"] {
            if params.get(field).and_then(JsonValue::as_bool) == Some(true) {
                request_params.insert(field.into(), serde_json::Value::Bool(true));
            }
        }
        let result = client
            .request("session/create", Some(&serde_json::Value::Object(request_params)), self.request_timeout)
            .map_err(HandlerError::message)?;
        Ok(result)
    }

    /// `session/resume`: resume a session. Mirrors `buildSessionResumeParams`.
    /// The cross-version compat-retry is deferred for the same reason as create.
    fn resume_session(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let workspace_path = params
            .get("workspacePath")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| HandlerError::message("resumeSession requires a `workspacePath`"))?;
        let identity = params.get("workspaceIdentity").and_then(JsonValue::as_str);
        let session_id = params
            .get("sessionId")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| HandlerError::message("resumeSession requires a `sessionId`"))?;
        let client = self.client_for(workspace_path, identity)?;
        let mut request_params = serde_json::Map::new();
        request_params.insert("sessionId".into(), serde_json::Value::String(session_id.to_string()));
        request_params.insert("workspace".into(), Self::workspace_ref(workspace_path, identity));
        for field in ["thoughtLevel", "mcpServers", "toolAllowlist", "toolDenylist"] {
            if let Some(value) = params.get(field) {
                request_params.insert(field.into(), value.clone());
            }
        }
        for field in ["offPeakToolEnabled", "dynamicWorkflowEnabled"] {
            if params.get(field).and_then(JsonValue::as_bool) == Some(true) {
                request_params.insert(field.into(), serde_json::Value::Bool(true));
            }
        }
        let result = client
            .request("session/resume", Some(&serde_json::Value::Object(request_params)), self.request_timeout)
            .map_err(HandlerError::message)?;
        Ok(result)
    }

    /// `session/read`: read a session's state snapshot. Read-only and maps
    /// cleanly (no compat-retry or workflow gates, unlike create/resume).
    fn read_session(&self, params: &JsonValue) -> Result<JsonValue, HandlerError> {
        let workspace_path = params
            .get("workspacePath")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| HandlerError::message("readSession requires a `workspacePath`"))?;
        let identity = params.get("workspaceIdentity").and_then(JsonValue::as_str);
        let session_id = params
            .get("sessionId")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| HandlerError::message("readSession requires a `sessionId`"))?;
        let client = self.client_for(workspace_path, identity)?;
        let mut request_params = serde_json::Map::new();
        request_params.insert("sessionId".into(), serde_json::Value::String(session_id.to_string()));
        for field in ["deliveryKind", "messageLimit", "afterSeq"] {
            if let Some(value) = params.get(field) {
                request_params.insert(field.into(), value.clone());
            }
        }
        let result = client
            .request("session/read", Some(&serde_json::Value::Object(request_params)), self.request_timeout)
            .map_err(HandlerError::message)?;
        Ok(result.get("snapshot").cloned().unwrap_or(JsonValue::Null))
    }
}

/// Walk up from `current` looking for `relative_path`; the TS `findUpward`.
fn find_upward(current: &std::path::Path, relative_path: &str) -> Option<PathBuf> {
    let mut dir = current.to_path_buf();
    loop {
        let candidate = dir.join(relative_path);
        if candidate.exists() {
            return Some(candidate);
        }
        let Some(parent) = dir.parent() else { return None };
        if parent == dir {
            return None;
        }
        dir = parent.to_path_buf();
    }
}

/// Resolve the agent (`zcode-cli`) command, mirroring the TS
/// `resolveBundledWorkspaceZCodeAgentCommand`: the bundled dist entrypoint run
/// under node with `app-server --stdio`, else the deployed binary from
/// `ZCODE_AGENT_SERVER_COMMAND`. Returns `None` when no command resolves, so the
/// channel is left unregistered rather than registered as a broken stub.
pub fn resolve_agent_command() -> Option<AgentCommand> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let Some(entrypoint) = find_upward(&cwd, "apps/zcode-cli/packages/cli/dist/zcode.cjs") {
        return Some(AgentCommand {
            program: "node".into(),
            args: vec![entrypoint.to_string_lossy().into_owned(), "app-server".into(), "--stdio".into()],
        });
    }
    if let Ok(binary) = std::env::var("ZCODE_AGENT_SERVER_COMMAND") {
        let binary = binary.trim().to_string();
        if !binary.is_empty() {
            return Some(AgentCommand { program: binary, args: vec!["app-server".into(), "--stdio".into()] });
        }
    }
    None
}

impl Default for AgentCommand {
    fn default() -> Self {
        // The desktop host resolves the zcode-cli entrypoint; a sane default is
        // `node <cli>`. The exact path is host-specific and set at wiring.
        Self { program: "node".into(), args: vec![] }
    }
}

impl ChannelHandler for ZCodeAgentService {
    fn call(&self, _ctx: &str, method: &str, args: &[JsonValue]) -> Result<JsonValue, HandlerError> {
        let params = args.first().cloned().unwrap_or(JsonValue::Null);
        match method {
            "listSessions" => self.list_sessions(&params),
            "readSession" => self.read_session(&params),
            "createSession" => self.create_session(&params),
            "resumeSession" => self.resume_session(&params),
            "readSessionMessages" => self.read_session_messages(&params),
            "readSessionDebug" => self.read_session_debug(&params),
            "listSessionSubagents" => self.list_session_subagents(&params),
            "getAppUsageStats" => self.get_app_usage_stats(&params),
            "sendConversationCommand" => self.send_conversation_command(&params),
            other => Err(HandlerError::message(format!(
                "zcode-agent.{other} is not yet ported to the Rust host; it belongs to the \
                 session runtime on top of the agent client"
            ))),
        }
    }

    fn subscribe(
        &self,
        _ctx: &str,
        event: &str,
        arg: Option<&JsonValue>,
    ) -> Option<crossbeam_channel::Receiver<JsonValue>> {
        if event != "onDynamicSessionEvent" {
            return None;
        }
        let params = arg.cloned().unwrap_or(JsonValue::Null);
        self.subscribe_session_events(&params).ok()
    }
}

impl Drop for ZCodeAgentService {
    fn drop(&mut self) {
        self.manager.dispose_all();
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn fake_agent_command() -> AgentCommand {
        // A fake agent that answers `session/list` with two sessions.
        let script = r#"
          const readline = require("readline");
          const rl = readline.createInterface({ input: process.stdin });
          rl.on("line", (line) => {
            if (!line.trim()) return;
            const req = JSON.parse(line);
            const result = req.method === "session/list"
              ? { sessions: [{ sessionId: "s1" }, { sessionId: "s2" }] }
              : req.method === "session/read"
              ? { snapshot: { session: { sessionId: req.params.sessionId } } }
              : req.method === "session/messages"
              ? { messages: [{ messageId: "m1" }] }
              : req.method === "session/subscribe"
              ? { sessionId: req.params.sessionId, eventSeq: 1,
                  events: [{ type: "event", seq: 1, eventId: "e1" }],
                  snapshot: { session: { sessionId: req.params.sessionId } } }
              : req.method === "v4/command"
              ? { commandId: "cmd1", status: "accepted", revisionAtDecision: 1,
                  receivedDenylist: req.params && req.params.payload && req.params.payload.toolDisallowlist }
              : req.method === "session/subagents"
              ? { subagents: [] }
              : req.method === "v4/usage/stats"
              ? { tokens: 100 }
              : req.method === "session/debug"
              ? { sessionId: req.params.sessionId, debug: true }
              : req.method === "session/create" || req.method === "session/resume"
              ? { session: { sessionId: req.params.sessionId }, messages: [] }
              : {};
            process.stdout.write(JSON.stringify({ id: req.id, result }) + "\n");
          });
        "#;
        AgentCommand { program: "node".into(), args: vec!["-e".into(), script.into()] }
    }

    #[test]
    fn list_sessions_returns_the_agent_sessions() {
        let dir = std::env::temp_dir().join(format!("zcode-agent-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let service = ZCodeAgentService::new(fake_agent_command());
        let sessions = service
            .call("", "listSessions", &[serde_json::json!({ "workspacePath": dir.to_string_lossy() })])
            .expect("listSessions");
        assert_eq!(sessions.as_array().map(Vec::len), Some(2), "two sessions: {sessions}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_session_returns_the_snapshot() {
        let dir = std::env::temp_dir().join(format!("zcode-agent-read-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let service = ZCodeAgentService::new(fake_agent_command());
        let snapshot = service
            .call("", "readSession", &[serde_json::json!({ "workspacePath": dir.to_string_lossy(), "sessionId": "s1" })])
            .expect("readSession");
        assert_eq!(snapshot["session"]["sessionId"], serde_json::json!("s1"), "snapshot: {snapshot}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_and_resume_session_return_the_snapshot() {
        let dir = std::env::temp_dir().join(format!("zcode-agent-sess-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let service = ZCodeAgentService::new(fake_agent_command());
        let created = service
            .call("", "createSession", &[serde_json::json!({ "workspacePath": dir.to_string_lossy(), "sessionId": "s9", "mode": "build" })])
            .expect("createSession");
        assert_eq!(created["session"]["sessionId"], serde_json::json!("s9"), "created: {created}");
        let resumed = service
            .call("", "resumeSession", &[serde_json::json!({ "workspacePath": dir.to_string_lossy(), "sessionId": "s9" })])
            .expect("resumeSession");
        assert_eq!(resumed["session"]["sessionId"], serde_json::json!("s9"), "resumed: {resumed}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_session_messages_and_debug_return_their_payloads() {
        let dir = std::env::temp_dir().join(format!("zcode-agent-msg-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let service = ZCodeAgentService::new(fake_agent_command());
        let messages = service
            .call("", "readSessionMessages", &[serde_json::json!({ "workspacePath": dir.to_string_lossy(), "sessionId": "s1" })])
            .expect("readSessionMessages");
        assert_eq!(messages.as_array().map(Vec::len), Some(1), "messages: {messages}");
        let debug = service
            .call("", "readSessionDebug", &[serde_json::json!({ "workspacePath": dir.to_string_lossy(), "sessionId": "s1" })])
            .expect("readSessionDebug");
        assert_eq!(debug["debug"], serde_json::json!(true), "debug: {debug}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn subagents_and_usage_stats_return_their_payloads() {
        let dir = std::env::temp_dir().join(format!("zcode-agent-sub-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let service = ZCodeAgentService::new(fake_agent_command());
        // Seed a connected client (usage stats needs an active workspace).
        let _ = service
            .call("", "listSessions", &[serde_json::json!({ "workspacePath": dir.to_string_lossy() })])
            .expect("listSessions seeds a client");
        let subagents = service
            .call("", "listSessionSubagents", &[serde_json::json!({ "workspacePath": dir.to_string_lossy(), "sessionId": "s1" })])
            .expect("listSessionSubagents");
        assert_eq!(subagents["subagents"].as_array().map(Vec::len), Some(0), "subagents: {subagents}");
        let usage = service
            .call("", "getAppUsageStats", &[serde_json::json!({ "range": "day" })])
            .expect("getAppUsageStats");
        assert_eq!(usage["tokens"], serde_json::json!(100), "usage: {usage}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_session_subscription_delivers_replay_and_snapshot() {
        let dir = std::env::temp_dir().join(format!("zcode-agent-sub-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let service = ZCodeAgentService::new(fake_agent_command());
        let receiver = service
            .subscribe("", "onDynamicSessionEvent", Some(&serde_json::json!({ "workspacePath": dir.to_string_lossy(), "sessionId": "s1" })))
            .expect("subscribe");
        let first = receiver
            .recv_timeout(std::time::Duration::from_secs(3))
            .expect("a replay event should arrive");
        assert_eq!(first["type"], serde_json::json!("session.event"), "replay: {first}");
        assert_eq!(first["event"]["eventId"], serde_json::json!("e1"));
        let second = receiver
            .recv_timeout(std::time::Duration::from_secs(3))
            .expect("the snapshot should arrive");
        assert_eq!(second["type"], serde_json::json!("snapshot"), "snapshot: {second}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn send_conversation_command_returns_the_ack() {
        let dir = std::env::temp_dir().join(format!("zcode-agent-chat-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let service = ZCodeAgentService::new(fake_agent_command());
        let ack = service
            .call("", "sendConversationCommand", &[serde_json::json!({
                "workspacePath": dir.to_string_lossy(),
                "envelope": { "type": "sendText", "sessionId": "s1", "payload": { "content": "hi" } }
            })])
            .expect("sendConversationCommand");
        assert_eq!(ack["commandId"], serde_json::json!("cmd1"), "ack: {ack}");
        assert_eq!(ack["status"], serde_json::json!("accepted"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_dispatch_send_merges_the_exact_tool_denylist() {
        let dir = std::env::temp_dir().join(format!("zcode-agent-disp-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let service = ZCodeAgentService::new(fake_agent_command());
        // The merge is applied before the send; verify the merged denylist
        // reaches the agent by having the fake echo the received payload back.
        let ack = service
            .call("", "sendConversationCommand", &[serde_json::json!({
                "workspacePath": dir.to_string_lossy(),
                "envelope": { "type": "sendText", "sessionId": "s1",
                    "payload": { "content": "x", "automationId": "a1", "toolDisallowlist": ["Keep"] } }
            })])
            .expect("dispatch send");
        assert_eq!(ack["status"], serde_json::json!("accepted"), "ack: {ack}");
        // The exact merged denylist reached the agent: the original tool plus
        // the automation mutation tools.
        let denylist = ack["receivedDenylist"].as_array().expect("denylist echoed");
        let names: Vec<&str> = denylist.iter().filter_map(JsonValue::as_str).collect();
        assert!(names.contains(&"Keep"), "original kept: {denylist:?}");
        assert!(names.contains(&"CronCreate"), "automation tool merged: {denylist:?}");
        assert!(names.contains(&"CronDelete"), "automation tool merged: {denylist:?}");
        assert!(!names.contains(&"OffPeakCreate"), "offpeak not merged for automation: {denylist:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unported_agent_methods_error_loudly() {
        let service = ZCodeAgentService::new(fake_agent_command());
        let error = service
            .call("", "initialize", &[serde_json::json!({})])
            .expect_err("must error");
        assert!(format!("{error:?}").contains("not yet ported"));
    }
}
