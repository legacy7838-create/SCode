//! Session, task-routing and remote-workspace commands.
//!
//! The port of four things:
//!   * the renderer↔host handshake (`host/index.ts:2734-2779` for
//!     `AttachServicePort` / `DetachServicePort`, `:2785-2939` for `InitLocal`,
//!     and `windowHostAttachmentRegistry.ts` for the registry itself);
//!   * the reload-survival rule recorded at `main/desktopWindowLifecycle.ts:130-163`;
//!   * task-notification dispatch and click routing
//!     (`main/desktopNotifications.ts`, `PlatformChannels.TaskNotificationClick`);
//!   * the remote/SSH attachment surface (`main/desktopMainIpcRemote.ts:392-571`,
//!     `main/desktopRemoteSessions.ts`, `host/windowRemoteConnectionRegistry.ts`).
//!
//! ## R2 — two channels, deliberately not merged
//!
//! `CUTOVER_SPEC` R2 records that the Tauri renderer reaches business services
//! over a WebSocket to `@zcode/server`, **not** over a transferable port, so
//! "the host" is a separate process. The consequences are load-bearing here:
//!
//!   * Everything Electron kept *inside* the Host — the attachment registry,
//!     the per-attachment owner/lease, the running-task count — has no home in
//!     this process. [`bound_endpoint`] is the only service plane Rust genuinely
//!     owns, and the handshake is gated on it. The registry below is keyed by
//!     *window label and renderer epoch*, not by a Host-owned attachment id,
//!     because inventing a Host-owned registry here would be exactly the merge
//!     R2 forbids.
//!   * Anything whose only true answer lives in the Host process is refused with
//!     a typed code rather than answered with a plausible default. See
//!     [`get_desktop_session_activity`].
//!
//! ## A port is never exposed before initialisation completes
//!
//! `host/index.ts:2926-2933` hands the transferred `MessagePort` to the
//! attachment registry only from inside `initializeServices`, i.e. after the
//! database reached `phase === "ready"`. A local `AttachServicePort` before
//! that point is *parked* in `pendingStartupAttachments`
//! (`host/index.ts:2739-2746`), not attached. [`begin_renderer_session`]
//! reproduces the gate: with no bound service endpoint there is no attachment
//! and no identity to hand out, and the caller is told `host-not-ready`.
//!
//! ## Renderer reload must not lose session identity
//!
//! `desktopWindowLifecycle.ts:136-166` is unusually explicit about this:
//!
//! > I once unconditionally killed the old host process and rebuilt it - the
//! > host and the CLI agent died together, and the running sessions disappeared
//! > directly. This is the root cause of "session identity is volatile".
//!
//! So [`begin_renderer_session`] mints a **fresh attachment id and a new
//! renderer epoch** on every call and deliberately **reuses the window's
//! `sessionId`**. [`detach_renderer_session`] disposes the attachment and keeps
//! the identity, which is the port of `port.once("close", …)` in
//! `windowHostAttachmentRegistry.attach` — the *port* dies with the renderer
//! context, the *session* does not.
//!
//! ## No second accepted queue
//!
//! `AGENTS.md`: "Accepted busy/running input is serially admitted by the
//! CLI/runtime `CommandInbox`; the Renderer only keeps unsubmitted drafts and
//! pending optimistic overlays, with Host owner/lease responsible for
//! routing." Nothing in this file buffers, reorders, retries or re-queues work.
//! [`SessionState`] holds identity labels and notification handles; a click
//! route is a map lookup, not a queue.
//!
//! ## NO_NATIVE_EQUIV
//!
//! * remote *connections* — [`connect_remote`], [`cancel_pending_remote_connection`],
//!   [`bind_remote_workspace_session_context`], [`dispose_remote_session`]. The
//!   connection registry, its per-window SSH serialisation lock and the remote
//!   Host generation barrier all live in the Node `@zcode/server/remote`
//!   process; see [`REMOTE_REFUSAL_REASON`].
//! * the running-agent-session count — [`get_desktop_session_activity`].
//! * the OS dock/taskbar badge — [`get_unread_badge_total`] reports
//!   `badgeSupported: false` rather than faking one (same decision as
//!   `commands/surface.rs:50-60`).
//! * same-tag notification *replacement* on macOS only: the macOS
//!   notification server has no notification id, so the XDG id that Linux and
//!   Windows use for replacement is ignored there. Dedupe and click routing
//!   still behave.
//! * the three remote lifecycle *subscriptions*
//!   (`onRemoteConnectionLog` / `onRemoteSessionClosed` /
//!   `onBotRemoteWorkspaceReconnected`) fire never, because the only producer
//!   ([`connect_remote`]) always refuses. The event names exist and the adapter
//!   subscribes to them, so wiring a remote backend later needs no vocabulary
//!   change — but until then they are dead channels, not simulated ones.
//!
//! `list_ssh_config_aliases` is **not** a refusal: it is
//! are local-machine reads with no Host involvement, and both are ported in
//! full (see [`ssh_config`]).
//!
//! ## Wiring
//!
//! `lib.rs` must add `pub mod session;` to `commands/mod.rs`,
//! `.manage(SessionState::default())` to `run()`, and list the commands in
//! `generate_handler!`. The `State` extractors panic at invoke time if the
//! `manage` call is missing.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use super::{require_registered_window, CommandError, CommandResult};
use crate::app_state::AppState;
use crate::events;
use crate::rpc::RpcHost;

/// The `clientMode` every desktop attachment carries.
///
/// `AGENTS.md` requires the Desktop `desktop-continuous` realtime link and the
/// mobile `web-remote-replayable` recovery link to stay visibly distinct, so the
/// value is a constant here rather than a free-form string on the payload.
pub const SESSION_CLIENT_MODE: &str = "desktop-continuous";

/// Machine-readable prefix on every refusal raised by this module.
///
/// The adapter matches on it to decide whether to render a reason or retry, so
/// it must stay byte-stable.
pub const NO_NATIVE_EQUIV: &str = "no-native-equiv";

/// Why a remote workspace cannot be established from this process.
pub const REMOTE_REFUSAL_REASON: &str = "remote workspace sessions are owned by the Node \
     `@zcode/server/remote` process: the connection registry, its per-window SSH serialisation lock \
     and the remote Host generation barrier are not reachable from the Tauri shell (CUTOVER_SPEC R2)";

/// Milliseconds since the Unix epoch.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ===========================================================================
// Service endpoint
// ===========================================================================

/// Where the service plane this window may attach to actually is.
///
/// A local struct rather than a reuse of
/// [`crate::commands::rpc::RpcEndpointState`]: the two channels must stay
/// visibly distinct (R2), and a distinct type makes it impossible for a
/// future change to the RPC command's shape to silently change the handshake's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceEndpointWire {
    pub ws_url: String,
    pub address: String,
    /// Channels this process serves natively. Anything else is reached over
    /// the WebSocket to `@zcode/server`.
    pub native_channel_count: usize,
    /// `true` when unported channels are relayed rather than served here.
    pub proxy_enabled: bool,
}

/// Read the in-process RPC endpoint, or `None` when nothing is bound.
pub fn bound_endpoint(rpc: &RpcHost) -> Option<ServiceEndpointWire> {
    let endpoint = rpc.endpoint()?;
    Some(ServiceEndpointWire {
        ws_url: endpoint.ws_url,
        address: endpoint.address,
        native_channel_count: rpc.channel_count(),
        proxy_enabled: rpc.proxy_enabled(),
    })
}

// ===========================================================================
// Session identity
// ===========================================================================

/// Lifecycle of a window's service attachment, from this shell's point of view.
///
/// Two states, not three. There is no way to observe a `failed` phase from
/// here: `lib.rs` tolerates a failed RPC bind and leaves the window on
/// `@zcode/server`, so "not attached" and "attached" is the whole truth this
/// process owns. A third, unreachable variant would be a lie of the same kind
/// as a typed-but-unimplemented member.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostPhase {
    /// No service endpoint is bound, so no attachment may be handed out.
    Starting,
    /// The service endpoint is bound and the window is attached to it.
    Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum HostPhaseSlot {
    #[default]
    Starting,
    Ready,
}

impl From<HostPhaseSlot> for HostPhase {
    fn from(value: HostPhaseSlot) -> Self {
        match value {
            HostPhaseSlot::Starting => HostPhase::Starting,
            HostPhaseSlot::Ready => HostPhase::Ready,
        }
    }
}

impl From<HostPhase> for HostPhaseSlot {
    fn from(value: HostPhase) -> Self {
        match value {
            HostPhase::Starting => HostPhaseSlot::Starting,
            HostPhase::Ready => HostPhaseSlot::Ready,
        }
    }
}

/// One window's session identity.
#[derive(Debug, Clone, Default)]
struct WindowSession {
    /// Stable for as long as the window is registered. Deliberately *not*
    /// regenerated on renderer reload — see the module header.
    session_id: String,
    /// The attachment currently serving the renderer, if any. Fresh per attach.
    attachment_id: Option<String>,
    /// Increments on every renderer attach; the renderer's own generation.
    renderer_epoch: u64,
    phase: HostPhaseSlot,
    host_id: Option<String>,
}

/// The identity half of a window's session, as the renderer sees it.
///
/// This is an **identity label, not a capability**: no command accepts it as
/// authority. Authorisation is always re-derived from the injected
/// `WebviewWindow` via `require_registered_window`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererSessionWire {
    pub session_id: String,
    /// `null` while the renderer is detached — mid-reload, or before the first
    /// attach. The *session* outlives the attachment; the port does not.
    #[serde(default)]
    pub attachment_id: Option<String>,
    pub renderer_epoch: u64,
    pub phase: HostPhase,
    #[serde(default)]
    pub host_id: Option<String>,
    pub client_mode: String,
}

/// Outcome of [`begin_renderer_session`].
///
/// A tagged value rather than a `Result` for the gate specifically: "the host
/// is not ready yet" is an ordinary state the UI has to render, not an
/// exception, and collapsing it into a string error is what makes the UI guess.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum RendererSessionHandshake {
    /// Attached. `service_endpoint` is present exactly when the gate passed.
    Ready {
        session: RendererSessionWire,
        service_endpoint: ServiceEndpointWire,
    },
    /// Rejected: no service endpoint is bound, so no attachment and no
    /// identity were created. The caller must retry.
    HostNotReady { phase: HostPhase },
}

/// Everything this shell owns for the session surface.
///
/// Deliberately *not* a second copy of anything `AppState` already holds:
/// `unread_count` and `active_session_id` live in `WindowState`
/// (`app_state.rs:18-27`) and are written only by `commands::window`. This type
/// adds what that one does not have — identity, renderer generation, and the
/// notification routing table — so there is exactly one owner per fact
/// (`AGENTS.md`: "Avoid duplicate state and multiple write paths").
#[derive(Debug, Default)]
pub struct SessionState {
    windows: Mutex<std::collections::HashMap<String, WindowSession>>,
    notifications: Mutex<NotificationRouter>,
    next_session: AtomicU64,
    next_attachment: AtomicU64,
    /// The single click-dispatch channel, created on the first notification.
    click_tx: Mutex<Option<crossbeam_channel::Sender<TaskClick>>>,
}

impl SessionState {
    fn next_session_id(&self) -> String {
        format!("zs-{}", self.next_session.fetch_add(1, Ordering::SeqCst))
    }

    fn next_attachment_id(&self) -> String {
        format!("za-{}", self.next_attachment.fetch_add(1, Ordering::SeqCst))
    }

    /// Attach `caller`'s renderer to the bound service endpoint.
    fn begin_attach(
        &self,
        caller: &str,
        endpoint: ServiceEndpointWire,
        host_id: Option<String>,
    ) -> RendererSessionHandshake {
        let session = {
            let mut windows = self.windows.lock();
            let entry = windows.entry(caller.to_string()).or_insert_with(|| WindowSession {
                session_id: self.next_session_id(),
                ..WindowSession::default()
            });
            // A window that has never attached has run no renderer, so its
            // first epoch is 1. Every later attach increments.
            entry.renderer_epoch += 1;
            entry.attachment_id = Some(self.next_attachment_id());
            entry.phase = HostPhaseSlot::Ready;
            if host_id.is_some() {
                entry.host_id = host_id;
            }
            wire_for(entry)
        };
        RendererSessionHandshake::Ready { session, service_endpoint: endpoint }
    }

    /// Read a window's identity without mutating it.
    pub fn session_for(&self, label: &str) -> Option<RendererSessionWire> {
        self.windows.lock().get(label).map(wire_for)
    }

    /// Drop just the attachment, keeping the session identity.
    ///
    /// This is the port of `port.once("close", …)` in
    /// `windowHostAttachmentRegistry.attach` (`:88-94`): the transferred port is
    /// recycled when the renderer context is destroyed, and nothing else is torn
    /// down with it. Returns `None` when the window never attached.
    pub fn detach(&self, label: &str) -> Option<RendererSessionWire> {
        let mut windows = self.windows.lock();
        let entry = windows.get_mut(label)?;
        entry.attachment_id = None;
        Some(wire_for(entry))
    }
}

fn wire_for(entry: &WindowSession) -> RendererSessionWire {
    RendererSessionWire {
        session_id: entry.session_id.clone(),
        attachment_id: entry.attachment_id.clone(),
        renderer_epoch: entry.renderer_epoch,
        phase: entry.phase.into(),
        host_id: entry.host_id.clone(),
        client_mode: SESSION_CLIENT_MODE.to_string(),
    }
}

/// The handshake body, split out so the gate is testable without a Tauri app.
fn begin_attach_for(
    caller: &str,
    rpc: &RpcHost,
    sessions: &SessionState,
    host_id: Option<String>,
) -> RendererSessionHandshake {
    match bound_endpoint(rpc) {
        Some(endpoint) => sessions.begin_attach(caller, endpoint, host_id),
        None => RendererSessionHandshake::HostNotReady { phase: HostPhase::Starting },
    }
}

/// Attach the calling renderer to this window's service session.
///
/// The port of the Electron handshake, which took two hops: main created a
/// `MessageChannelMain` and posted `AttachServicePort` at the Host
/// (`desktopWindowLifecycle.ts:143-158`), then the Host attached the received
/// port (`host/index.ts:2734-2770`). Only after that second hop did the renderer
/// hold a service port. Tauri has no transferable port (R2), so the single hop
/// is "here is the endpoint, bound and serving" — and refusing to do that before
/// the bind succeeds is the `host/index.ts:2926-2933` gate.
///
/// The caller is derived from the injected `WebviewWindow`; `sessionId` and
/// `requestId` are never read from the payload, because Tauri has no
/// `event.senderFrame.url` to validate them against (`PORT_STATUS.md:161`).
#[tauri::command]
pub fn begin_renderer_session(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    sessions: State<'_, SessionState>,
    rpc: State<'_, RpcHost>,
) -> CommandResult<RendererSessionHandshake> {
    require_registered_window(&state, window.label())?;
    let host_id = state.with_window(window.label(), |w| w.host_id.clone()).flatten();
    let handshake = begin_attach_for(window.label(), &rpc, &sessions, host_id);
    if let RendererSessionHandshake::Ready { session, .. } = &handshake {
        let _ = app.emit(events::RENDERER_SESSION_ATTACHED, session);
    }
    Ok(handshake)
}

/// Read the calling window's session identity without attaching a renderer.
///
/// `getRendererSession` has no Electron counterpart — it is new surface, added
/// because Tauri cannot observe webview navigation, so a renderer that reloads
/// has to be able to ask "is my identity still the same one?" rather than infer
/// it.
#[tauri::command]
pub fn get_renderer_session(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    sessions: State<'_, SessionState>,
) -> CommandResult<RendererSessionWire> {
    require_registered_window(&state, window.label())?;
    sessions
        .session_for(window.label())
        .ok_or_else(|| CommandError::WindowUnavailable(window.label().to_string()))
}

/// Release the calling renderer's attachment, keeping the session identity.
///
/// Electron's equivalent is implicit: the old `MessagePort` closes with the
/// renderer context and the registry's `port.once("close")` handler disposes the
/// attachment (`windowHostAttachmentRegistry.ts:88-94`). It is an explicit
/// command here only because Tauri's `WindowEvent` cannot observe webview
/// navigation, so the renderer has to report its own teardown. It is idempotent
/// and never touches `session_id` or `renderer_epoch`.
#[tauri::command]
pub fn detach_renderer_session(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    sessions: State<'_, SessionState>,
) -> CommandResult<Option<RendererSessionWire>> {
    require_registered_window(&state, window.label())?;
    let detached = sessions.detach(window.label());
    if let Some(session) = &detached {
        let _ = app.emit_to(window.label(), events::RENDERER_SESSION_DETACHED, session);
    }
    Ok(detached)
}

// ===========================================================================
// Unread badge aggregation
// ===========================================================================

/// Aggregated unread state for the app badge and the in-app indicator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BadgeStateWire {
    /// Sum over every *main* window — `AppState::total_unread`, which already
    /// excludes auxiliary surfaces (`app_state.rs:16-17`).
    pub total: u64,
    /// Per-window breakdown, sorted by label, so the UI can show which window
    /// is behind without depending on `HashMap` iteration order.
    pub per_window: Vec<(String, u64)>,
    /// Always `false`: Tauri v2 exposes no `setBadgeCount` and no cross-platform
    /// dock/taskbar badge API. `commands/surface.rs:50-60` records the same
    /// decision; reporting the capability keeps the UI from rendering a badge it
    /// believes is live.
    pub badge_supported: bool,
}

/// The aggregation, split out so it is testable without a Tauri app.


/// Read the aggregated unread state.


// ===========================================================================
// Session activity
// ===========================================================================

/// The shape `getDesktopSessionActivity` would have
/// (`packages/shared/src/platform.ts:901-903`).
///
/// Never constructed: [`get_desktop_session_activity`] always refuses. It
/// exists so the command's return type states the member's contract instead of
/// borrowing an unrelated one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionActivityWire {
    pub running_agent_session_count: u64,
}

/// How many agent sessions the desktop is running.
///
/// **NO_NATIVE_EQUIV.** Electron answered this from the Host process, which owns
/// the running `CommandInbox` and the per-session leases (`AGENTS.md`: "Accepted
/// busy/running input is serially admitted by the CLI/runtime `CommandInbox`").
/// Under Tauri that Host is `@zcode/server`, a different process (R2), so this
/// process has no counter to read and no honest way to derive one: counting
/// *active task sessions per window* is a different quantity wearing this
/// member's name, and the member's own doc says "non-desktop platforms may
/// return 0" — which is precisely the plausible-wrong-answer substitution this
/// cutover exists to remove. The UI shows a session count in the quit warning,
/// so `0` would be believed.
///
/// The command exists so the refusal is produced in Rust and carries a reason
/// the UI can render, instead of being invented in TypeScript.
/// The refusal itself, split out so the code and the reason are assertable
/// without a live `WebviewWindow`.
fn get_desktop_session_activity_refusal() -> CommandError {
    CommandError::Forbidden(format!(
        "{NO_NATIVE_EQUIV}: the running agent session count is owned by the Host process, which \
         under Tauri is `@zcode/server` and not this process (CUTOVER_SPEC R2)"
    ))
}

#[tauri::command]
pub fn get_desktop_session_activity(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<SessionActivityWire> {
    require_registered_window(&state, window.label())?;
    Err(get_desktop_session_activity_refusal())
}

// ===========================================================================
// Task notifications
// ===========================================================================

/// Duplicate-suppression window, verbatim from
/// `TASK_NOTIFICATION_DEDUPE_WINDOW_MS` (`desktopNotifications.ts:7`).
pub const TASK_NOTIFICATION_DEDUPE_WINDOW_MS: u64 = 3_000;

/// Cap on simultaneously live notifications, verbatim from
/// `MAX_ACTIVE_TASK_NOTIFICATIONS` (`desktopNotifications.ts:8`).
pub const MAX_ACTIVE_TASK_NOTIFICATIONS: usize = 100;

/// Cap on remembered task→window routes.
///
/// Not in the original: Electron captured the sender window in a closure
/// (`desktopNotifications.ts:139-141`), so its route table was whatever the
/// closures held and died with them. A table needs a bound, and entries for
/// windows that no longer exist are dropped on the next notification, so this is
/// a ceiling on live windows × tasks, not an unbounded log.
pub const MAX_TRACKED_TASK_ROUTES: usize = 512;

/// Task status, as `TaskNotificationPayload.status`.
///
/// The TypeScript member spells these with underscores
/// (`"permission_request"`); the wire here is kebab-case, matching the
/// `HostMessage`/`HostEvent` discipline (`PORT_STATUS.md:117-122`). The adapter
/// in `src/platform/tauriPlatform.ts` is the single translation point, so the
/// vocabulary is translated once rather than forked across two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskStatus {
    Completed,
    Failed,
    PermissionRequest,
    ElicitationRequest,
    FeedbackUpdate,
}

impl TaskStatus {
    /// `permission_request` / `elicitation_request` are the two blocking
    /// human-in-the-loop statuses, and they dedupe on `requestId` rather than on
    /// `taskId` — see [`notification_dedupe_key`].
    pub fn is_blocking_request(self) -> bool {
        matches!(self, TaskStatus::PermissionRequest | TaskStatus::ElicitationRequest)
    }

    /// The wire spelling, so log lines and dedupe keys agree.
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Completed => "completed",
            TaskStatus::Failed => "failed",
            TaskStatus::PermissionRequest => "permission-request",
            TaskStatus::ElicitationRequest => "elicitation-request",
            TaskStatus::FeedbackUpdate => "feedback-update",
        }
    }
}

/// The payload of `showTaskNotification` (`packages/shared/src/platform.ts:35`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskNotificationPayload {
    pub task_id: String,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub title: String,
    pub body: String,
}

/// Why a task notification was not shown.
///
/// All three are values, not errors: Electron returned `false` for each and the
/// renderer treats non-delivery as a normal outcome, not a fault.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationSkipReason {
    /// `isAnyAppWindowFocused()` — the user is already looking at the app
    /// (`desktopNotifications.ts:20-24`).
    AppFocused,
    /// Inside the 3 s dedupe window for the same status+target
    /// (`shouldSuppressDuplicateTaskNotification`, `:26-48`).
    Duplicate,
    /// No notification server on this desktop
    /// (`Notification.isSupported()`, `:110-113`).
    Unsupported,
}

/// Result of `showTaskNotification`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskNotificationResult {
    pub delivered: bool,
    /// The identity the notification was filed under, so the renderer can
    /// correlate a later click with this call.
    pub tag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<NotificationSkipReason>,
}

impl TaskNotificationResult {
    fn delivered(tag: impl Into<String>) -> Self {
        Self { delivered: true, tag: tag.into(), reason: None }
    }

    fn skipped(tag: impl Into<String>, reason: NotificationSkipReason) -> Self {
        Self { delivered: false, tag: tag.into(), reason: Some(reason) }
    }
}

/// The dedupe key for one notification.
///
/// Port of `shouldSuppressDuplicateTaskNotification`
/// (`desktopNotifications.ts:39-44`):
///
/// > elicitation_request and permission_request both represent a specific
/// > human-machine blocking request. If you still press taskId to remove
/// > duplicates, the second notification will be missed within 3 seconds for
/// > consecutive AskUserQuestion/plan confirmations for the same task.
///
/// so those two key on `requestId` (falling back to `taskId`) and the rest key
/// on `taskId` alone. `status` is part of the key, so a `failed` never
/// suppresses a `completed` for the same task.
pub fn notification_dedupe_key(
    status: TaskStatus,
    task_id: &str,
    request_id: Option<&str>,
) -> String {
    let target = if status.is_blocking_request() {
        request_id.map(str::trim).filter(|id| !id.is_empty()).unwrap_or(task_id)
    } else {
        task_id
    };
    format!("{}:{target}", status.as_str())
}

/// The identity a notification is filed under, also used as its tag.
///
/// Electron used the raw `taskId` as the notification `tag`
/// (`desktopPlatform.ts` → `showTaskNotification` → `tag: payload.taskId`). The
/// two blocking statuses carry a `requestId` that distinguishes consecutive asks
/// inside one task, so those file under the same identity the dedupe key uses;
/// otherwise the second ask would replace the first instead of following it.
pub fn notification_tag(payload: &TaskNotificationPayload) -> String {
    notification_dedupe_key(
        payload.status,
        &payload.task_id,
        payload.request_id.as_deref(),
    )
}

/// Sliding-window dedupe registry, keyed exactly as Electron's
/// `recentTaskNotificationTimestamps` Map is.
#[derive(Debug, Default)]
pub struct DedupeWindow {
    last_shown_ms: std::collections::HashMap<String, u64>,
}

impl DedupeWindow {
    /// Record `key` at `now_ms` and report whether it is a duplicate.
    ///
    /// Expired entries are pruned on every call, as at
    /// `desktopNotifications.ts:31-35` — an unbounded map keyed by task id is a
    /// slow leak and the port must not introduce one the original avoided.
    ///
    /// A suppressed call deliberately does **not** refresh the timestamp, so a
    /// burst of events stays suppressed for the whole window rather than
    /// sliding forward forever.
    pub fn should_suppress(&mut self, key: &str, now_ms: u64) -> bool {
        self.last_shown_ms
            .retain(|_, seen| now_ms.saturating_sub(*seen) <= TASK_NOTIFICATION_DEDUPE_WINDOW_MS);
        match self.last_shown_ms.get(key) {
            Some(seen)
                if now_ms.saturating_sub(*seen) < TASK_NOTIFICATION_DEDUPE_WINDOW_MS =>
            {
                true
            }
            _ => {
                self.last_shown_ms.insert(key.to_string(), now_ms);
                false
            }
        }
    }

    pub fn len(&self) -> usize {
        self.last_shown_ms.len()
    }

    pub fn is_empty(&self) -> bool {
        self.last_shown_ms.is_empty()
    }
}

/// Which window owns a task, so a click can be routed back to it.
///
/// Electron captured `senderWindow` in a closure
/// (`desktopNotifications.ts:139-141`) and lost it with the closure; after a
/// renderer reload a click had nowhere to go. A table keyed by task id survives
/// the reload, which is the same class of fix as the surviving session id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRoute {
    pub window_label: String,
    pub request_id: Option<String>,
}

/// Look up the window that owns `task_id`.
///
/// Pure, so the routing rule is testable without a notification server; the
/// emitting wrapper around it is four lines.
pub fn route_task_notification_click(
    routes: &std::collections::HashMap<String, TaskRoute>,
    task_id: &str,
) -> Option<TaskRoute> {
    routes.get(task_id).cloned()
}


/// An insertion-ordered set of keys with a hard cap.
///
/// Extracted from both notification tables so the eviction rule is testable
/// without a live notification server, and so "re-record moves to the back"
/// cannot be reimplemented slightly differently in the two places that need it.
#[derive(Debug)]
struct BoundedOrder {
    order: std::collections::VecDeque<String>,
    cap: usize,
}

impl BoundedOrder {
    fn new(cap: usize) -> Self {
        Self { order: std::collections::VecDeque::with_capacity(cap), cap }
    }

    /// Record `key` as the most recent and return the key evicted to stay
    /// within the cap, if any.
    fn record(&mut self, key: &str) -> Option<String> {
        self.order.retain(|existing| existing != key);
        self.order.push_back(key.to_string());
        if self.order.len() > self.cap {
            self.order.pop_front()
        } else {
            None
        }
    }

    /// The recorded keys, oldest first — i.e. the order the cap would evict in.
    ///
    /// Exists so the eviction and re-tagging rules are assertable directly; a
    /// test that cannot observe the order has to infer it from side effects,
    /// which is how a cap that evicts the *newest* entry still passes. Test-only:
    /// production never reads the order back out, so it is gated to the test build
    /// to stay out of the lib's dead-code set.
    #[cfg(test)]
    fn iter(&self) -> std::collections::vec_deque::Iter<'_, String> {
        self.order.iter()
    }

    fn forget(&mut self, key: &str) {
        self.order.retain(|existing| existing != key);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.order.len()
    }
}

/// A live platform notification, kept so its default action still arrives.
#[derive(Debug)]
struct ActiveNotification {
    /// The platform handle, or `None` for an entry that was recorded without one.
    ///
    /// `Option` rather than a plain handle so the router's bookkeeping — dedupe
    /// window, live cap, eviction order, re-tagging — is testable without a live
    /// notification server, which `notify_rust::NotificationHandle` requires.
    /// Every production entry is `Some`: the only constructor is
    /// [`show_task_notification`], which builds it straight from `show()`.
    handle: Option<notify_rust::NotificationHandle>,
    window_label: String,
    task_id: String,
}

/// State for the notification surface: dedupe, click routing, live handles.
#[derive(Debug)]
struct NotificationRouter {
    dedupe: DedupeWindow,
    routes: std::collections::HashMap<String, TaskRoute>,
    /// Show order of `routes`, so the cap evicts the oldest.
    route_order: BoundedOrder,
    /// Live handles keyed by tag.
    live: std::collections::HashMap<String, ActiveNotification>,
    live_order: BoundedOrder,
}

impl Default for NotificationRouter {
    fn default() -> Self {
        Self {
            dedupe: DedupeWindow::default(),
            routes: std::collections::HashMap::new(),
            route_order: BoundedOrder::new(MAX_TRACKED_TASK_ROUTES),
            live: std::collections::HashMap::new(),
            live_order: BoundedOrder::new(MAX_ACTIVE_TASK_NOTIFICATIONS),
        }
    }
}

impl NotificationRouter {
    /// Apply the dedupe rule, then record the route on acceptance.
    fn accept(
        &mut self,
        payload: &TaskNotificationPayload,
        caller: &str,
        now_ms: u64,
        live_windows: &HashSet<String>,
    ) -> bool {
        let key = notification_tag(payload);
        if self.dedupe.should_suppress(&key, now_ms) {
            return false;
        }
        self.prune_routes(live_windows);
        self.routes.insert(
            payload.task_id.clone(),
            TaskRoute {
                window_label: caller.to_string(),
                request_id: payload.request_id.clone(),
            },
        );
        if let Some(evicted) = self.route_order.record(&payload.task_id) {
            self.routes.remove(&evicted);
        }
        true
    }

    /// Forget routes whose window is gone. A destroyed window's task can never
    /// be clicked back into, so keeping the entry would be a permanent leak.
    fn prune_routes(&mut self, live_windows: &HashSet<String>) {
        let dead: Vec<String> = self
            .routes
            .iter()
            .filter(|(_, route)| !live_windows.contains(&route.window_label))
            .map(|(task_id, _)| task_id.clone())
            .collect();
        for task_id in dead {
            self.routes.remove(&task_id);
            self.route_order.forget(&task_id);
        }
    }

    /// Record a live handle, evicting the oldest past the cap.
    ///
    /// Eviction is show order, matching the `Set` iteration Electron used
    /// (`desktopNotifications.ts:50-65`): the first value of an
    /// insertion-ordered `Set` is the oldest.
    fn retain_live(&mut self, tag: String, entry: ActiveNotification) {
        self.live.insert(tag.clone(), entry);
        if let Some(evicted) = self.live_order.record(&tag) {
            self.live.remove(&evicted);
        }
    }
}

/// A task notification click, resolved to the window that owns the task.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TaskClick {
    window_label: String,
    task_id: String,
}

/// Stable platform notification id for a tag.
///
/// Electron passed the task id as the notification `tag`, and
/// `tauri-plugin-notification` has no tag support (recorded in
/// `commands/native.rs`). `notify-rust` reaches the platform's own mechanism:
/// the XDG notification id, where re-notifying with the same id *replaces* the
/// previous notification. FNV-1a keeps the mapping stable across processes
/// without adding a hasher dependency.
pub fn platform_tag(tag: &str) -> u32 {
    const FNV_OFFSET: u32 = 0x811c_9dc5;
    const FNV_PRIME: u32 = 0x0100_0193;
    tag.bytes().fold(FNV_OFFSET, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(FNV_PRIME)
    })
}

/// True when any registered window currently has focus.
///
/// The port of `isAnyAppWindowFocused` (`desktopNotifications.ts:20-24`).
/// Deriving this from the OS is the point: the renderer is never asked, because
/// a renderer that is about to lose focus would answer "not focused" and the
/// notification would fire at the user mid-click.
fn any_app_window_focused(app: &AppHandle, state: &AppState) -> bool {
    state.window_labels().iter().any(|label| {
        app.get_webview_window(label)
            .and_then(|w| w.is_focused().ok())
            .unwrap_or(false)
    })
}

/// Start the one click-dispatch thread, on first use.
///
/// `crossbeam_channel` rather than a thread per notification: one thread also
/// puts every `emit_to` on a single known thread instead of on whatever thread
/// the notification backend happened to use, and a thread per task would be a
/// resource regression the Electron original never paid (it had one JS object
/// and one `once("click")` listener per notification, not one thread).
fn ensure_click_dispatcher(
    slot: &Mutex<Option<crossbeam_channel::Sender<TaskClick>>>,
    app: &AppHandle,
) -> CommandResult<crossbeam_channel::Sender<TaskClick>> {
    if let Some(existing) = slot.lock().clone() {
        return Ok(existing);
    }
    let (tx, rx) = crossbeam_channel::unbounded::<TaskClick>();
    let handle = app.clone();
    std::thread::Builder::new()
        .name("zcode-task-notification-clicks".to_string())
        .spawn(move || {
            for click in rx {
                dispatch_task_click(&handle, click);
            }
        })
        .map_err(|e| CommandError::Platform(format!("spawn click dispatcher: {e}")))?;
    *slot.lock() = Some(tx.clone());
    Ok(tx)
}

/// Focus the owning window and tell its renderer a task was clicked.
///
/// The port of `notification.once("click", …)`
/// (`desktopNotifications.ts:151-168`): restore if minimised, show if hidden,
/// focus, then
/// `senderWindow.webContents.send(PlatformChannels.TaskNotificationClick, taskId)`.
fn dispatch_task_click(app: &AppHandle, click: TaskClick) {
    if let Some(window) = app.get_webview_window(&click.window_label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Err(error) =
        app.emit_to(&click.window_label, events::TASK_NOTIFICATION_CLICK, &click.task_id)
    {
        tracing::warn!(
            window = %click.window_label,
            %error,
            "task notification click could not be routed to the renderer"
        );
    }
}

/// Is a notification server reachable on this desktop?
///
/// The port of `Notification.isSupported()`. `dbus_stack()` is `None` when no
/// session bus is reachable, which on Linux is the equivalent of "the OS has no
/// notification facility"; on macOS and Windows the backend is always compiled
/// in, so the question is answered by `show()` instead.
fn notifications_supported() -> bool {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        notify_rust::dbus_stack().is_some()
    }
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    {
        true
    }
}

/// Fire the task notification for `status`, and register its click route.
///
/// The port of `dispatchTaskNotification` (`desktopNotifications.ts:101-178`),
/// check for check, in the original order:
///   1. validate the payload (Electron: zod; here: `deny_unknown_fields`);
///   2. is a notification server available at all;
///   3. is any app window focused — if so, stay silent;
///   4. both title and body non-empty;
///   5. inside the 3 s dedupe window;
///   6. show, silently, and remember the window that owns the task.
///
/// Step 6 is where this differs from the plugin-based port: Electron held the
/// `Notification` object alive until it was clicked or closed, because
/// "notification" and "can be evoked by clicking" must share one lifecycle
/// (`desktopNotifications.ts:135-138`). `tauri-plugin-notification` cannot do
/// that — its `show()` returns nothing, so the route would be lost with the
/// temporary — which is why `onTaskNotificationClick` could not be ported on top
/// of it. `notify-rust` returns a handle that owns the platform connection, so
/// the route survives, and the handle is retained in [`SessionState`] for
/// exactly that reason.
///
/// Synchronous by design: `show()` is one D-Bus round-trip, and the Electron
/// original was synchronous inside `ipcMain.handle` too. The blocking wait for
/// the click happens on a dedicated thread, never here.
#[tauri::command]
pub fn show_task_notification(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    sessions: State<'_, SessionState>,
    payload: TaskNotificationPayload,
) -> CommandResult<TaskNotificationResult> {
    require_registered_window(&state, window.label())?;

    let tag = notification_tag(&payload);
    if !notifications_supported() {
        return Ok(TaskNotificationResult::skipped(tag, NotificationSkipReason::Unsupported));
    }
    if any_app_window_focused(&app, &state) {
        return Ok(TaskNotificationResult::skipped(tag, NotificationSkipReason::AppFocused));
    }

    let title = payload.title.trim();
    let body = payload.body.trim();
    if title.is_empty() || body.is_empty() {
        // Same refusal as `native::show_notification`: the renderer owns the
        // i18n copy, so empty copy is a caller bug and has to be visible rather
        // than a silent no-op the UI would read as "shown".
        return Err(CommandError::InvalidPayload(
            "task notification title and body must not be empty".to_string(),
        ));
    }

    let live_windows: HashSet<String> = state.window_labels().into_iter().collect();
    {
        let mut router = sessions.notifications.lock();
        if !router.accept(&payload, window.label(), now_ms(), &live_windows) {
            return Ok(TaskNotificationResult::skipped(tag, NotificationSkipReason::Duplicate));
        }
    }

    let mut notification = notify_rust::Notification::new();
    notification
        .summary(title)
        .body(body)
        .appname("ZCode")
        // `silent: true` in the Electron original
        // (`desktopNotifications.ts:145`) — the agent already produced a sound.
        .hint(notify_rust::Hint::SuppressSound(true))
        // Electron's `tag`, expressed through the platform's own replacement
        // mechanism. On macOS the notification server ignores the id, so
        // same-tag *replacement* is NO_NATIVE_EQUIV there; the route and the
        // dedupe still behave.
        .id(platform_tag(&tag));
    let handle = notification
        .show()
        .map_err(|e| CommandError::Platform(format!("show task notification: {e}")))?;

    let entry = ActiveNotification {
        handle: Some(handle),
        window_label: window.label().to_string(),
        task_id: payload.task_id.clone(),
    };
    let task_id = entry.task_id.clone();
    sessions.notifications.lock().retain_live(tag.clone(), entry);

    let clicks = ensure_click_dispatcher(&sessions.click_tx, &app)?;
    // One waiter per live notification, mirroring Electron's one
    // `once("click")` listener per `Notification`. It exits as soon as the
    // platform reports an action or a close.
    let waiter_tag = tag.clone();
    let waiter_app = app.clone();
    std::thread::Builder::new()
        .name("zcode-task-notification-wait".to_string())
        .spawn(move || {
            // Take ownership of the handle here rather than in the command: the
            // handle keeps the platform connection alive, and dropping it before
            // the action arrives is exactly how the action gets lost.
            let Some(ActiveNotification { handle, window_label, task_id }) = waiter_app
                .state::<SessionState>()
                .notifications
                .lock()
                .live
                .remove(&waiter_tag)
            else {
                // Evicted by the cap, or already routed: nothing to wait on.
                return;
            };
            // An entry with no platform handle has no action to wait for. Every
            // production entry has one, so this is the test-shaped path.
            let Some(handle) = handle else {
                return;
            };
            let mut clicked = false;
            handle.wait_for_action(|action| {
                // `"default"` is a click on the notification body; `"__closed"`
                // is the library's internal close marker, not an action.
                if action == "default" && !clicked {
                    clicked = true;
                    let _ = clicks.send(TaskClick { window_label: window_label.clone(), task_id });
                }
            });
        })
        .map_err(|e| CommandError::Platform(format!("spawn notification waiter: {e}")))?;

    tracing::debug!(task_id, window = window.label(), tag, "task notification shown");
    Ok(TaskNotificationResult::delivered(tag))
}

// ===========================================================================
// Remote workspaces
// ===========================================================================

/// A remote workspace target, matching `remoteTargetSchema`'s two variants
/// (`packages/shared/src/remoteTarget.ts:7-21`).
///
/// `deny_unknown_fields` is load-bearing: a target carries an optional password
/// and key passphrase, and silently dropping an unrecognised key would mean
/// connecting with different credentials than the user chose. Secrets are
/// accepted (so a caller is not forced to strip them) but never logged or
/// returned — the refusal echoes only `kind`, `requestId` and `connectTrigger`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum RemoteTarget {
    Ssh {
        host: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        port: Option<u16>,
        username: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ssh_config_alias: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        private_key_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        asset_install_mode: Option<String>,
    },
}

impl RemoteTarget {
    pub fn kind(&self) -> &'static str {
        match self {
            RemoteTarget::Ssh { .. } => "ssh",
        }
    }
}

/// Request shape of `connectRemote` (`ConnectRemoteRequest`,
/// `packages/shared/src/platform.ts:436-442`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectRemoteRequest {
    pub target: RemoteTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect_trigger: Option<String>,
}

impl ConnectRemoteRequest {
    /// The same normalisation Electron applied at
    /// `desktopMainIpcRemote.ts:415-433`: a blank string means "absent", and an
    /// unrecognised trigger is `new` rather than a rejection.
    pub fn normalized_request_id(&self) -> Option<&str> {
        self.request_id.as_deref().map(str::trim).filter(|id| !id.is_empty())
    }

    pub fn normalized_workspace_path(&self) -> Option<&str> {
        self.workspace_path.as_deref().map(str::trim).filter(|p| !p.is_empty())
    }

    pub fn normalized_workspace_identity(&self) -> Option<&str> {
        self.workspace_identity
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
    }

    pub fn connect_trigger(&self) -> &str {
        match self.connect_trigger.as_deref() {
            Some("reconnect") => "reconnect",
            Some("restore") => "restore",
            _ => "new",
        }
    }
}

/// Outcome of `connect_remote`.
///
/// A tagged value, never a `Result::Err` for the refusal: the UI has to render
/// *why* a remote workspace is unavailable, and this carries that as data.
/// Returning the web-shaped `{ success: false, error: "not wired yet" }` string
/// would be a different member behind the same signature.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ConnectRemoteOutcome {
    /// Reserved. No code path can produce it: `connect_remote` refuses before
    /// any connection is attempted. It is present so the wire shape is total and
    /// the adapter can switch exhaustively, and so adding a real backend later
    /// is an additive change rather than a wire break.
    Connected { session_id: String },
    /// The typed refusal.
    NoNativeEquiv {
        /// Always [`NO_NATIVE_EQUIV`].
        code: String,
        /// Which remote kind was asked for, so the UI can say "SSH is not
        /// available in this build" rather than "remote is not available".
        kind: String,
        reason: String,
        /// The caller's correlation id, echoed back as Electron did.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        /// The trigger Electron would have reported to telemetry.
        connect_trigger: String,
    },
    /// The payload did not satisfy `remoteTargetSchema`.
    InvalidPayload { error: String },
}

/// Validate a `connect_remote` request the way `remoteTargetSchema` does.
///
/// `Some(reason)` when the payload is unusable, `None` when it is well formed.
/// The check runs *before* the refusal so a malformed request is still reported
/// as malformed — otherwise the UI cannot tell "we will never support this" from
/// "you sent the wrong shape".
pub fn validate_connect_remote(request: &ConnectRemoteRequest) -> Option<String> {
    match &request.target {
        RemoteTarget::Ssh { host, username, port, private_key_path, .. } => {
            if host.trim().is_empty() {
                return Some("ssh target requires a non-empty host".to_string());
            }
            if username.trim().is_empty() {
                return Some("ssh target requires a non-empty username".to_string());
            }
            if *port == Some(0) {
                return Some("ssh port must be between 1 and 65535".to_string());
            }
            if private_key_path.as_deref().is_some_and(|p| p.trim().is_empty()) {
                return Some("ssh privateKeyPath must not be blank".to_string());
            }
            None
        }
    }
}

/// `connectRemote` — **NO_NATIVE_EQUIV**, after real payload validation.
///
/// Electron created a remote logical session here
/// (`desktopMainIpcRemote.ts:392-491` → `desktopRemoteSessions.ts` →
/// `windowRemoteConnectionRegistry.ts`), transferred a port into the Host, and
/// held a generation barrier so a new attachment could not step on the previous
/// per-workspace release (`host/index.ts:2747-2752`). None of that exists in
/// this process and none of it can be faked: a refusal is the only answer that
/// is not a lie.
/// The decision [`connect_remote`] makes, split out so the validation order and
/// the refusal's contents are assertable without a live `WebviewWindow`.
fn refuse_connect_remote(request: &ConnectRemoteRequest) -> ConnectRemoteOutcome {
    if let Some(error) = validate_connect_remote(request) {
        return ConnectRemoteOutcome::InvalidPayload { error };
    }
    tracing::warn!(
        kind = request.target.kind(),
        request_id = request.normalized_request_id().unwrap_or(""),
        connect_trigger = request.connect_trigger(),
        "remote workspace connect refused: no native equivalent"
    );
    ConnectRemoteOutcome::NoNativeEquiv {
        code: NO_NATIVE_EQUIV.to_string(),
        kind: request.target.kind().to_string(),
        reason: REMOTE_REFUSAL_REASON.to_string(),
        request_id: request.normalized_request_id().map(str::to_string),
        connect_trigger: request.connect_trigger().to_string(),
    }
}

#[tauri::command]
pub fn connect_remote(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    request: ConnectRemoteRequest,
) -> CommandResult<ConnectRemoteOutcome> {
    require_registered_window(&state, window.label())?;
    Ok(refuse_connect_remote(&request))
}

/// `cancelPendingRemoteConnection` — a truthful no-op.
///
/// Electron cancelled an in-flight connection so that closing the dialog would
/// stop the background download (`desktopMainIpcRemote.ts:493-511`,
/// `SSHDialog.tsx:205-206`). No connection can be in flight, because
/// [`connect_remote`] refuses before it starts one, so reporting success is
/// accurate rather than a swallowed error. The alternative — refusing this too
/// — would make the UI show an error for cancelling something never started.
#[tauri::command]
pub fn cancel_pending_remote_connection(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    request_id: Option<String>,
) -> CommandResult<()> {
    require_registered_window(&state, window.label())?;
    tracing::debug!(
        request_id = request_id.as_deref().unwrap_or("").trim(),
        "cancel pending remote connection: nothing is ever in flight"
    );
    Ok(())
}

/// `BindRemoteWorkspaceSessionContextRequest`
/// (`packages/shared/src/platform.ts:448-452`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteSessionContext {
    pub remote_session_id: String,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_identity: Option<String>,
}

impl RemoteSessionContext {
    /// Electron threw "remote workspace context is missing sessionId or
    /// workspacePath" for exactly these two (`desktopMainIpcRemote.ts:529-531`).
    pub fn validate(&self) -> CommandResult<()> {
        if self.remote_session_id.trim().is_empty() || self.workspace_path.trim().is_empty() {
            return Err(CommandError::InvalidPayload(
                "remote workspace context is missing sessionId or workspacePath".to_string(),
            ));
        }
        Ok(())
    }
}

/// `bindRemoteWorkspaceSessionContext` — **NO_NATIVE_EQUIV**.
///
/// Binds the canonical workspace identity to an existing remote logical session
/// (`desktopMainIpcRemote.ts:513-541`). No such session can exist, so this
/// refuses — after validating the payload, so a caller bug stays
/// distinguishable from an unsupported feature.
#[tauri::command]
pub fn bind_remote_workspace_session_context(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    context: RemoteSessionContext,
) -> CommandResult<()> {
    require_registered_window(&state, window.label())?;
    context.validate()?;
    Err(CommandError::Forbidden(format!("{NO_NATIVE_EQUIV}: {REMOTE_REFUSAL_REASON}")))
}

/// `disposeRemoteSession` — **NO_NATIVE_EQUIV**.
#[tauri::command]
pub fn dispose_remote_session(
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> CommandResult<()> {
    require_registered_window(&state, window.label())?;
    if session_id.trim().is_empty() {
        return Err(CommandError::InvalidPayload("session id must not be empty".to_string()));
    }
    Err(CommandError::Forbidden(format!("{NO_NATIVE_EQUIV}: {REMOTE_REFUSAL_REASON}")))
}

// ===========================================================================
// SSH config aliases
// ===========================================================================

mod ssh_config;

/// List the SSH config aliases on this machine that can fill the connect form.
///
/// Port of `listSSHConfigAliasesFromLocalConfig`
/// (`packages/services/src/system/sshConfigAlias.ts:642-708`): parse
/// `~/.ssh/config` with `Include` expansion, enumerate connectable single-word
/// `Host` patterns, resolve each one, and — when an `ssh` binary is available —
/// confirm with `ssh -G` under a 1500 ms deadline.
///
/// This is a local-machine read with no Host involvement and no business state,
/// so it is ported rather than refused. The wiring is in [`ssh_config`].
#[tauri::command]
pub async fn list_ssh_config_aliases() -> CommandResult<Vec<ssh_config::SshConfigAliasOption>> {
    let options = tauri::async_runtime::spawn_blocking(ssh_config::list_from_local_config).await?;
    Ok(options)
}

#[cfg(test)]
mod tests;
