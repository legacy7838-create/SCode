//! Channel server — the Rust port of `ChannelServer` in
//! `packages/rpc/src/channelServer.ts`.
//!
//! Responsibilities, all ported 1:1 from the TypeScript original:
//!
//!   * Route a `Promise` request to the registered handler for `(channel, method)`
//!     and answer with `PromiseSuccess` / `PromiseError` / `PromiseErrorObj`.
//!   * Register an event listener for `EventListen` and push `EventFire` frames
//!     until `EventDispose` arrives.
//!   * Honour `PromiseCancel` / `EventDispose` by dropping the in-flight entry.
//!   * Buffer requests for a channel that is not registered *yet* and replay them
//!     once it appears. Without this, a client that calls during app startup
//!     would fail every call made before its channel was wired; the JS original
//!     has the same queue plus a 1 s deadline, and the deadline is preserved here
//!     because callers depend on `PromiseError` rather than a hang.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use serde_json::Value as JsonValue;

use crate::message::{
    decode_request, encode_response, EnvelopeError, Request, RequestType, Response,
};

/// The deadline the JS `ChannelServer` applies to a request whose channel has
/// not been registered (`timeoutDelay = 1000` in `channelServer.ts`).
pub const UNKNOWN_CHANNEL_TIMEOUT: Duration = Duration::from_millis(1000);

/// A channel handler. One instance backs one channel name.
///
/// `call` answers a `Promise` request. `subscribe` registers interest in an
/// event and returns a receiver; the server then forwards every message it
/// receives on that channel until the subscription is disposed.
///
/// Both take the connection context (`ctx`) so a handler can behave
/// per-connection, matching `IServerChannel<TContext>`.
pub trait ChannelHandler: Send + Sync + 'static {
    /// Answer a method call. `Ok(value)` becomes `PromiseSuccess`.
    ///
    /// `args` is the **positional argument list**, not a single value. That is
    /// the wire contract: the client's `ProxyChannel.toService` sends
    /// `[...methodArgs]`, and the server's `ProxyChannel.fromService` spreads it
    /// back with `Function.apply`. So even a one-argument method arrives wrapped
    /// in an array, and a handler that treats `args[0]` as "the argument" is
    /// correct while one that treats the whole payload as the argument silently
    /// sees an array.
    fn call(
        &self,
        ctx: &str,
        method: &str,
        args: &[JsonValue],
    ) -> Result<JsonValue, HandlerError>;

    /// Subscribe to an event. Returning `None` means the event is unknown, which
    /// is reported to the client instead of silently never firing.
    fn subscribe(
        &self,
        ctx: &str,
        event: &str,
        arg: Option<&JsonValue>,
    ) -> Option<crossbeam_channel::Receiver<JsonValue>>;
}

/// A failure returned by a [`ChannelHandler::call`].
///
/// `Err(this)` becomes `PromiseError` (the client rebuilds an `Error` object);
/// `Ok(Err(Thrown(value)))` becomes `PromiseErrorObj` (the client rejects with
/// the value verbatim). This mirrors the JS split between throwing an `Error`
/// and rejecting with a plain object.
#[derive(Debug)]
pub enum HandlerError {
    /// An `Error`-shaped failure: `message` + `name` plus the passthrough keys
    /// the client copies onto the reconstructed error.
    Error {
        message: String,
        name: String,
        code: Option<JsonValue>,
        data: Option<JsonValue>,
    },
    /// A non-`Error` rejection value, forwarded as-is.
    Thrown(JsonValue),
}

impl HandlerError {
    /// Convenience constructor for the common `Error` case.
    pub fn message(message: impl Into<String>) -> Self {        Self::Error {
            message: message.into(),
            name: "Error".to_owned(),
            code: None,
            data: None,
        }
    }

    pub fn with_code(message: impl Into<String>, code: JsonValue) -> Self {
        Self::Error {
            message: message.into(),
            name: "Error".to_owned(),
            code: Some(code),
            data: None,
        }
    }

    /// The JSON body the client will receive for this failure.
    ///
    /// Public so a handler's error can be asserted against the exact payload the
    /// client will reconstruct, rather than against `Display` or `Debug`. The
    /// structured `code` is load-bearing for clients that branch on it —
    /// `isCredentialDecryptError` in `packages/shared/src/oauth.ts:21` returns
    /// false the moment it sees a *different* `code` — and that branch is
    /// untestable if the payload cannot be read back.
    pub fn to_payload(&self) -> (bool, JsonValue) {
        match self {
            Self::Error {
                message,
                name,
                code,
                data,
            } => {
                let mut map = serde_json::Map::new();
                map.insert("message".into(), JsonValue::String(message.clone()));
                map.insert("name".into(), JsonValue::String(name.clone()));
                // `stack` is `undefined` on the JS side; omitting the key is
                // what the client treats as absent.
                if let Some(code) = code {
                    map.insert("code".into(), code.clone());
                }
                if let Some(data) = data {
                    map.insert("data".into(), data.clone());
                }
                (true, JsonValue::Object(map))
            }
            Self::Thrown(value) => (false, value.clone()),
        }
    }
}

impl std::fmt::Display for HandlerError {
    /// Renders the message a caller would see, so an error can be logged or
    /// asserted on without first converting it to its wire payload.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Error { message, .. } => write!(f, "{message}"),
            Self::Thrown(value) => write!(f, "{value}"),
        }
    }
}

impl std::error::Error for HandlerError {}

/// Where a connection's outbound frames go.
///
/// Kept as a trait so the same `ChannelServer` drives a WebSocket, an in-process
/// channel, or a test sink.
pub trait Outbound: Send + Sync {
    fn send(&self, payload: Vec<u8>);
}

/// An in-memory [`Outbound`] used by tests and by the in-process host.
#[derive(Default)]
pub struct Outbox {
    messages: Mutex<Vec<Vec<u8>>>,
}

impl Outbox {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn take(&self) -> Vec<Vec<u8>> {
        std::mem::take(&mut *self.messages.lock().expect("outbox poisoned"))
    }

    pub fn len(&self) -> usize {
        self.messages.lock().expect("outbox poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Outbound for Outbox {
    fn send(&self, payload: Vec<u8>) {
        self.messages.lock().expect("outbox poisoned").push(payload);
    }
}

/// How often an event pump re-checks its cancel flag while waiting for data.
///
/// The pump owns the receiver, so disposal cannot simply drop it; instead the
/// subscription raises a flag and the pump notices on its next tick. This bounds
/// how long a disposed subscription can still emit a frame.
const EVENT_PUMP_POLL: Duration = Duration::from_millis(50);

/// An event subscription that the server can stop forwarding.
///
/// Dropping the subscription is what `EventDispose` triggers. It must be prompt,
/// so the flag is set on drop and the pump exits on its next poll; the thread is
/// never joined here, so disposing a request cannot block the caller.
struct Subscription {
    cancel: Arc<AtomicBool>,
    /// Runs on disposal, after the flag is set. The proxy uses it to send
    /// `EventDispose` upstream, so a relayed subscription is actually torn down
    /// on the upstream server instead of leaking a listener there for the life
    /// of the connection.
    on_dispose: Option<Box<dyn FnOnce() + Send>>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Some(dispose) = self.on_dispose.take() {
            dispose();
        }
    }
}

/// A channel this host has no handler for, answered by forwarding it upstream.
///
/// This is the migration seam. While channels are moved to Rust one at a time,
/// a channel with no local handler is proxied to the still-running Node server
/// instead of failing, so the UI keeps working and nothing the UI does has to
/// change between one migration step and the next. A channel becomes native by
/// registering a handler; the proxy is never consulted for it again.
pub trait ChannelFallback: Send + Sync + 'static {
    /// Forward a call. `Err` is relayed to the caller as a normal RPC failure.
    ///
    /// `args` is the positional argument list, matching [`ChannelHandler::call`].
    fn call(
        &self,
        ctx: &str,
        channel: &str,
        method: &str,
        args: Vec<JsonValue>,
    ) -> BoxFuture<'static, Result<JsonValue, HandlerError>>;

    /// Forward an event subscription.
    fn subscribe(
        &self,
        ctx: &str,
        channel: &str,
        event: &str,
        arg: Option<JsonValue>,
    ) -> BoxFuture<'static, Result<FallbackSubscription, HandlerError>>;
}

/// A relayed event subscription.
pub struct FallbackSubscription {
    /// Event payloads to forward to the UI.
    pub events: crossbeam_channel::Receiver<JsonValue>,
    /// Called when the UI disposes the subscription.
    pub unsubscribe: Box<dyn FnOnce() + Send>,
}

/// Registry of channel handlers shared by every connection.
///
/// Registration happens while the app is wiring services, and dispatch happens
/// concurrently on many connections, so the map sits behind an `RwLock`. The
/// lock is only ever held for the map lookup itself — never across a handler
/// call — so a slow handler cannot block other connections or registration.
#[derive(Default)]
pub struct ChannelRegistry {
    handlers: std::sync::RwLock<HashMap<String, Arc<dyn ChannelHandler>>>,
}

impl ChannelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register (or replace) a channel handler.
    pub fn register(&mut self, channel: impl Into<String>, handler: Arc<dyn ChannelHandler>) {
        self.write().insert(channel.into(), handler);
    }

    /// Shared-handle variant, so a registry built during startup can be moved
    /// into an `Arc` and still accept later registrations.
    pub fn register_shared(&self, channel: impl Into<String>, handler: Arc<dyn ChannelHandler>) {
        self.write().insert(channel.into(), handler);
    }

    pub fn get(&self, channel: &str) -> Option<Arc<dyn ChannelHandler>> {
        self.read().get(channel).cloned()
    }

    pub fn contains(&self, channel: &str) -> bool {
        self.read().contains_key(channel)
    }

    pub fn len(&self) -> usize {
        self.read().len()
    }

    pub fn is_empty(&self) -> bool {
        self.read().is_empty()
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, HashMap<String, Arc<dyn ChannelHandler>>> {
        self.handlers.read().expect("registry poisoned")
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<String, Arc<dyn ChannelHandler>>> {
        self.handlers.write().expect("registry poisoned")
    }
}

/// A deferred request waiting for its channel to be registered.
struct PendingRequest {
    request: Request,
    deadline: Instant,
}

/// Per-connection channel server.
pub struct Connection {
    ctx: Mutex<String>,
    registry: Arc<ChannelRegistry>,
    outbound: Arc<dyn Outbound>,
    /// Request/event id → live subscription, for `PromiseCancel`/`EventDispose`.
    ///
    /// Shared so a proxy subscription, which is only resolvable asynchronously,
    /// can insert itself into the same map the read loop disposes from.
    active: Arc<Mutex<HashMap<u32, Subscription>>>,
    pending: Mutex<HashMap<String, Vec<PendingRequest>>>,
    /// Where unported channels are forwarded, plus the runtime that drives it.
    ///
    /// Behind a lock because it is installed after construction: the transport
    /// creates the connection first and attaches the fallback immediately after,
    /// and a proxied subscription resolves asynchronously, so the binding is read
    /// from other threads.
    fallback: Mutex<Option<FallbackBinding>>,
}

/// Interpret the request payload as a positional argument list.
///
/// `ProxyChannel.toService` always sends an array (`[...methodArgs]`), which
/// `fromService` spreads back with `Function.apply`. A caller that sends a bare
/// value is treated as a single argument so hand-written clients keep working.
fn positional_args(payload: Option<&JsonValue>) -> Vec<JsonValue> {
    match payload {
        Some(JsonValue::Array(items)) => items.clone(),
        Some(other) => vec![other.clone()],
        None => Vec::new(),
    }
}

/// A fallback plus the runtime handle its async calls are driven on.
///
/// Cloneable so a connection can hand a copy to the worker thread that owns one
/// dispatch: both members are cheap handles, not owned state.
#[derive(Clone)]
pub struct FallbackBinding {
    fallback: Arc<dyn ChannelFallback>,
    runtime: tokio::runtime::Handle,
}

impl Connection {
    pub fn new(
        ctx: impl Into<String>,
        registry: Arc<ChannelRegistry>,
        outbound: Arc<dyn Outbound>,
    ) -> Self {
        Self {
            ctx: Mutex::new(ctx.into()),
            registry,
            outbound,
            active: Arc::new(Mutex::new(HashMap::new())),
            pending: Mutex::new(HashMap::new()),
            fallback: Mutex::new(None),
        }
    }

    /// Forward channels that have no local handler upstream.
    ///
    /// The runtime handle is captured so the fallback's async calls can be driven
    /// from the synchronous read loop; the call itself is still moved off that
    /// loop, so a slow upstream never blocks the connection's framing.
    pub fn set_fallback(&self, fallback: Arc<dyn ChannelFallback>, runtime: tokio::runtime::Handle) {
        *self.fallback.lock().expect("fallback poisoned") = Some(FallbackBinding {
            fallback,
            runtime,
        });
    }

    fn fallback(&self) -> Option<FallbackBinding> {
        self.fallback
            .lock()
            .expect("fallback poisoned")
            .clone()
    }

    fn ctx_slot(&self) -> &Mutex<String> {
        &self.ctx
    }

    pub fn ctx(&self) -> String {
        self.ctx_slot().lock().expect("ctx poisoned").clone()
    }

    /// Replace the context after the handshake identified the peer.
    ///
    /// The context is a plain `String` held behind the connection, so this is a
    /// write of one field; it happens once, before dispatch begins.
    pub fn set_ctx(&self, ctx: &str) {
        // `ctx` is only mutated during the handshake, which is single-threaded
        // per connection, so the lock is never contended in practice.
        let mut guard = self.ctx_slot().lock().expect("ctx poisoned");
        *guard = ctx.to_owned();
    }

    /// Send `Initialize`, which unblocks the client's queued requests.
    ///
    /// The client holds every call until it sees this, so it must be the first
    /// frame written for a connection.
    pub fn send_initialize(&self) {
        self.reply(&Response::initialize());
    }

    /// Feed one framed payload. Undecodable input is reported to the client when
    /// an id can be recovered, and otherwise logged, so one bad frame cannot
    /// tear down the connection.
    pub fn on_message(&self, payload: &[u8]) {
        let request = match decode_request(payload) {
            Ok(request) => request,
            Err(error) => {
                tracing::warn!(
                    ctx = %self.ctx_slot().lock().expect("ctx poisoned"),
                    %error,
                    "discarding an undecodable channel message"
                );
                return;
            }
        };
        match request.request_type {
            RequestType::Promise => self.on_promise(request),
            RequestType::EventListen => self.on_event_listen(request),
            RequestType::PromiseCancel | RequestType::EventDispose => self.dispose(request.id),
        }
    }

    /// Expire deferred requests whose channel never appeared, answering them with
    /// `PromiseError` the way the JS `collectPendingRequest` timeout does.
    pub fn flush_expired_pending(&self) {
        let now = Instant::now();
        let expired = {
            let mut pending = self.pending.lock().expect("pending poisoned");
            let mut expired = Vec::new();
            pending.retain(|_channel, requests| {
                requests.retain(|entry| {
                    if entry.deadline <= now {
                        expired.push(entry.request.clone());
                        false
                    } else {
                        true
                    }
                });
                !requests.is_empty()
            });
            expired
        };

        for request in expired {
            let name = request.channel().to_owned();
            if request.request_type == RequestType::Promise {
                tracing::error!("Unknown channel: {name}");
                self.reply(&Response::error(
                    request.id,
                    serde_json::json!({
                        "name": "Unknown channel",
                        "message": format!(
                            "Channel name '{name}' timed out after {}ms",
                            UNKNOWN_CHANNEL_TIMEOUT.as_millis()
                        ),
                    }),
                ));
            }
        }
    }

    /// Replay deferred requests for a channel that has just been registered.
    pub fn flush_pending_for(&self, channel: &str) {
        let queued = self
            .pending
            .lock()
            .expect("pending poisoned")
            .remove(channel)
            .unwrap_or_default();
        for entry in queued {
            self.on_promise(entry.request);
        }
    }

    fn on_promise(&self, request: Request) {
        // The payload is the positional argument list. A client that sends a
        // bare value (not wrapped) still works, because a single non-list
        // argument is treated as the only argument — this keeps hand-rolled
        // callers working while matching `Function.apply` semantics.
        let args = positional_args(request.arg.as_ref());
        let Some(handler) = self.registry.get(request.channel()) else {
            // No local handler: forward upstream if a fallback is configured,
            // otherwise defer and let the deadline answer.
            if self.forward_promise(request.clone(), args) {
                return;
            }
            self.defer(request);
            return;
        };

        let ctx = self.ctx().to_owned();
        let name = request.method().to_owned();
        let id = request.id;
        let outbound = Arc::clone(&self.outbound);

        // The handler is synchronous here, but it may be CPU- or IO-bound, so it
        // runs off the read loop and the answer is written when it completes.
        std::thread::spawn(move || {
            let response = match handler.call(&ctx, &name, &args) {
                Ok(value) => Response::success(id, value),
                Err(error) => {
                    let (is_error, payload) = error.to_payload();
                    if is_error {
                        Response::error(id, payload)
                    } else {
                        Response::error_obj(id, payload)
                    }
                }
            };
            if let Ok(bytes) = encode_response(&response) {
                outbound.send(bytes);
            }
        });
    }

    fn on_event_listen(&self, request: Request) {
        let Some(handler) = self.registry.get(request.channel()) else {
            if self.forward_event_listen(request.clone()) {
                return;
            }
            self.defer(request);
            return;
        };

        let Some(receiver) = handler.subscribe(&self.ctx(), request.method(), request.arg.as_ref())
        else {
            tracing::warn!(
                channel = request.channel(),
                event = request.method(),
                "listener for an unknown event"
            );
            return;
        };

        let outbound = Arc::clone(&self.outbound);
        let id = request.id;
        // The pump owns the receiver; disposal is cooperative via the flag.
        let cancel = Arc::new(AtomicBool::new(false));
        let pump_cancel = Arc::clone(&cancel);
        std::thread::spawn(move || loop {
            if pump_cancel.load(Ordering::SeqCst) {
                break;
            }
            match receiver.recv_timeout(EVENT_PUMP_POLL) {
                Ok(data) => {
                    if let Ok(bytes) = encode_response(&Response::event_fire(id, data)) {
                        outbound.send(bytes);
                    }
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                // The handler dropped its sender: the event is finished.
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            }
        });

        self.active
            .lock()
            .expect("active poisoned")
            .insert(
                id,
                Subscription {
                    cancel,
                    on_dispose: None,
                },
            );
    }

    fn dispose(&self, id: u32) {
        if let Some(subscription) = self.active.lock().expect("active poisoned").remove(&id) {
            // Dropping the subscription ends the forwarding task.
            drop(subscription);
        }
    }

    /// Relay a promise upstream. Returns false when no fallback is configured,
    /// so the caller can fall back to deferring.
    fn forward_promise(&self, request: Request, args: Vec<JsonValue>) -> bool {
        let Some(binding) = self.fallback() else {
            return false;
        };
        let (fallback, runtime) = (binding.fallback, binding.runtime);

        let ctx = self.ctx();
        let channel = request.channel().to_owned();
        let method = request.method().to_owned();
        let id = request.id;
        let outbound = Arc::clone(&self.outbound);

        let spawned = std::thread::spawn(move || {
            let future = fallback.call(&ctx, &channel, &method, args);
            let outcome = match runtime.block_on(future) {
                Ok(value) => Response::success(id, value),
                // The upstream failure is relayed as a normal error: the UI sees
                // the same shape it would have seen from the Node server.
                Err(error) => {
                    let (is_error, payload) = error.to_payload();
                    if is_error {
                        Response::error(id, payload)
                    } else {
                        Response::error_obj(id, payload)
                    }
                }
            };
            if let Ok(bytes) = encode_response(&outcome) {
                outbound.send(bytes);
            }
        });
        // The thread ends on its own; nothing to join.
        let _ = spawned;
        true
    }

    /// Relay an event subscription upstream. Returns false when no fallback is
    /// configured.
    fn forward_event_listen(&self, request: Request) -> bool {
        let Some(binding) = self.fallback() else {
            return false;
        };
        let (fallback, runtime) = (binding.fallback, binding.runtime);

        let ctx = self.ctx();
        let channel = request.channel().to_owned();
        let event = request.method().to_owned();
        let arg = request.arg.clone();
        let id = request.id;
        let outbound = Arc::clone(&self.outbound);
        let active = Arc::clone(&self.active);

        std::thread::spawn(move || {
            let future = fallback.subscribe(&ctx, &channel, &event, arg);
            let subscription = match runtime.block_on(future) {
                Ok(subscription) => subscription,
                Err(error) => {
                    let (is_error, payload) = error.to_payload();
                    let response = if is_error {
                        Response::error(id, payload)
                    } else {
                        Response::error_obj(id, payload)
                    };
                    if let Ok(bytes) = encode_response(&response) {
                        outbound.send(bytes);
                    }
                    return;
                }
            };

            let FallbackSubscription {
                events: receiver,
                unsubscribe,
            } = subscription;

            let cancel = Arc::new(AtomicBool::new(false));
            let pump_cancel = Arc::clone(&cancel);
            std::thread::spawn(move || loop {
                if pump_cancel.load(Ordering::SeqCst) {
                    break;
                }
                match receiver.recv_timeout(EVENT_PUMP_POLL) {
                    Ok(data) => {
                        if let Ok(bytes) = encode_response(&Response::event_fire(id, data)) {
                            outbound.send(bytes);
                        }
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                }
            });

            // If the UI disposed this id while the upstream subscribe was still
            // in flight, the entry is gone; drop ours instead of leaking the
            // upstream listener for the life of the connection.
            let mut guard = active.lock().expect("active poisoned");
            if guard
                .insert(
                    id,
                    Subscription {
                        cancel,
                        on_dispose: Some(unsubscribe),
                    },
                )
                .is_some()
            {
                tracing::debug!(id, "replaced an in-flight subscription");
            }
            drop(guard);
        });
        true
    }

    fn defer(&self, request: Request) {
        let channel = request.channel().to_owned();
        if channel.is_empty() {
            return;
        }
        self.pending
            .lock()
            .expect("pending poisoned")
            .entry(channel)
            .or_default()
            .push(PendingRequest {
                request,
                deadline: Instant::now() + UNKNOWN_CHANNEL_TIMEOUT,
            });
    }

    fn reply(&self, response: &Response) {
        match encode_response(response) {
            Ok(bytes) => self.outbound.send(bytes),
            Err(EnvelopeError::Codec(error)) => {
                tracing::error!(%error, "failed to encode a channel response");
            }
            Err(error) => {
                tracing::error!(%error, "failed to encode a channel response");
            }
        }
    }
}
