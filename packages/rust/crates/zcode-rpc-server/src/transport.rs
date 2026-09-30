//! WebSocket transport — the accept loop that turns a socket into a session.
//!
//! The channel protocol is transport-agnostic: it only needs ordered bytes in
//! and bytes out. This module supplies the network edge using `tokio-tungstenite`
//! and bridges it to [`Session`], which owns the protocol state.
//!
//! # Why a separate edge module
//!
//! Keeping the listener here means the protocol core ([`crate::frame`],
//! [`crate::message`], [`crate::channel`]) stays free of async and of any I/O,
//! so it can be tested synchronously and reused over a different transport — a
//! Unix socket for an in-process host, or Tauri's own IPC — without touching the
//! protocol code.
//!
//! # Ordering guarantee
//!
//! `Initialize` is written before the first frame is read, mirroring
//! `ChannelServer`'s `deferInit = false`. The client holds every request until
//! it sees that frame, so a request can never race ahead of readiness.
//!
//! Note there is no client→server context prologue on this transport: the
//! browser client used by the web app and the Tauri renderer never sends one.
//! See the note in `serve_connection`.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use crate::channel::{ChannelFallback, ChannelRegistry, Outbound};
use crate::frame::{write_regular, FrameStream};
use crate::message::encode_response;
use crate::message::Response;
use crate::session::{Session, SessionConfig};

/// Errors raised while running the listener.
#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("failed to bind {addr}: {source}")]
    Bind {
        addr: String,
        #[source]
        source: std::io::Error,
    },
    #[error("accept failed: {0}")]
    Accept(#[source] std::io::Error),
}

/// A bound listener, not yet accepting.
///
/// Separated from [`RpcServer::serve`] so a host can learn the real port before
/// the accept loop starts — which matters when binding port 0, and removes the
/// race between binding and the first client connect.
pub struct RpcListener {
    /// Held as a std listener until `serve` runs.
    ///
    /// `tokio::net::TcpListener::from_std` requires a live reactor, so a
    /// synchronous host (Tauri's `setup()`, or a unit test) cannot construct
    /// the tokio type at bind time. Keeping the std socket here makes binding
    /// genuinely synchronous and defers the conversion to `serve`, which by
    /// definition already runs inside a runtime.
    std_listener: std::net::TcpListener,
    /// Captured at bind time, with any ephemeral port resolved.
    bound_addr: std::net::SocketAddr,
    registry: Arc<ChannelRegistry>,
    config: SessionConfig,
    /// Shared so a host can attach the fallback after binding, once its upstream
    /// client has connected. The Tauri host binds in a synchronous `setup()` but
    /// can only open the client connection asynchronously, so a value fixed at
    /// construction time would either be absent or require blocking.
    fallback: FallbackSlot,
}

/// A fallback that may be attached before or after the listener is bound.
///
/// A `std` mutex, not a tokio one, on purpose: the slot is only ever held for the
/// instant it takes to clone the binding out, never across an `await`, and a
/// builder method that may run either in a sync host (`Tauri`'s `setup()`) or
/// inside a runtime must be able to lock it without blocking the runtime.
pub type FallbackSlot = Arc<std::sync::Mutex<Option<ChannelFallbackBinding>>>;

/// A fallback plus the runtime its async calls are driven on.
#[derive(Clone)]
pub struct ChannelFallbackBinding {
    pub fallback: Arc<dyn ChannelFallback>,
    pub runtime: tokio::runtime::Handle,
}

impl RpcListener {
    /// The address actually bound, with any ephemeral port resolved.
    pub fn local_addr(&self) -> std::io::Result<std::net::SocketAddr> {
        Ok(self.bound_addr)
    }

    /// The fallback slot, so a host that bound before its upstream client was
    /// ready can attach one after the listener is already running.
    pub fn fallback_slot(&self) -> FallbackSlot {
        Arc::clone(&self.fallback)
    }

    /// Accept connections until the process ends.
    ///
    /// Each accepted socket gets its own [`Session`]; a failure on one
    /// connection is logged and dropped without affecting the others.
    pub async fn serve(self) {
        // Destructure up front: the socket moves into tokio, the rest is kept.
        let Self {
            std_listener,
            bound_addr,
            registry,
            config,
            fallback,
        } = self;

        let local = bound_addr.to_string();
        tracing::info!(%local, channels = registry.len(), "zcode rpc server listening");

        if let Err(error) = std_listener.set_nonblocking(true) {
            tracing::error!(%error, "rpc accept loop cannot start");
            return;
        }
        let listener = match TcpListener::from_std(std_listener) {
            Ok(listener) => listener,
            Err(error) => {
                // Without a reactor the accept loop cannot run at all. Report it
                // rather than spinning on an error that will never clear.
                tracing::error!(%error, "rpc accept loop cannot start");
                return;
            }
        };

        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(error) => {
                    tracing::warn!(%error, "rpc accept failed");
                    continue;
                }
            };
            let registry = Arc::clone(&registry);
            let config = config.clone();
            let fallback = fallback.clone();
            tokio::spawn(async move {
                if let Err(error) = serve_connection(stream, registry, config, fallback).await {
                    tracing::warn!(%peer, %error, "rpc connection ended with an error");
                } else {
                    tracing::info!(%peer, "rpc connection closed");
                }
            });
        }
    }

    /// Hand the bound socket to tokio. Must be called from within a runtime.
    #[allow(dead_code)]
    fn into_tokio_listener(self) -> std::io::Result<TcpListener> {
        self.std_listener.set_nonblocking(true)?;
        TcpListener::from_std(self.std_listener)
    }
}

/// A running WebSocket RPC server.
pub struct RpcServer {
    registry: Arc<ChannelRegistry>,
    config: SessionConfig,
    /// Applied to every accepted connection, so unported channels are forwarded
    /// rather than failing. Shared so it can also be attached after binding.
    fallback: FallbackSlot,
}

impl RpcServer {
    pub fn new(registry: Arc<ChannelRegistry>) -> Self {
        Self {
            registry,
            config: SessionConfig::default(),
            fallback: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    /// Forward channels with no local handler to `fallback`.
    ///
    /// This is the migration seam: with it set the host answers every channel the
    /// UI asks for, serving the ported ones itself and relaying the rest.
    pub fn with_fallback(
        self,
        fallback: Arc<dyn ChannelFallback>,
        runtime: tokio::runtime::Handle,
    ) -> Self {
        *lock_slot(&self.fallback) = Some(ChannelFallbackBinding { fallback, runtime });
        self
    }

    /// The fallback slot, so a host that bound before its upstream client was
    /// ready can attach one later.
    pub fn fallback_slot(&self) -> FallbackSlot {
        Arc::clone(&self.fallback)
    }

    /// Attach a fallback to an already-bound listener.
    ///
    /// The async counterpart of [`RpcServer::with_fallback`], for a host that
    /// binds synchronously and only afterwards opens its upstream connection.
    pub fn set_fallback(
        slot: &FallbackSlot,
        fallback: Arc<dyn ChannelFallback>,
        runtime: tokio::runtime::Handle,
    ) {
        *lock_slot(slot) = Some(ChannelFallbackBinding { fallback, runtime });
    }

    pub fn with_config(mut self, config: SessionConfig) -> Self {
        self.config = config;
        self
    }

    /// Bind `addr` without yet accepting.
    pub async fn bind(self, addr: impl Into<String>) -> Result<RpcListener, ServerError> {
        self.bind_sync(&addr.into())
    }

    /// Bind synchronously, for hosts whose startup path is not async.
    ///
    /// Tauri runs `setup()` before the event loop and expects a plain function,
    /// so nothing here may require a tokio reactor. Binding eagerly also means
    /// the caller knows the real port before any client can try to connect —
    /// important when the configured port is 0.
    pub fn bind_sync(self, addr: &str) -> Result<RpcListener, ServerError> {
        let std_listener = std::net::TcpListener::bind(addr).map_err(|source| ServerError::Bind {
            addr: addr.to_owned(),
            source,
        })?;
        let bound_addr = std_listener
            .local_addr()
            .map_err(|source| ServerError::Bind {
                addr: addr.to_owned(),
                source,
            })?;
        Ok(RpcListener {
            std_listener,
            bound_addr,
            registry: self.registry,
            config: self.config,
            fallback: self.fallback,
        })
    }

    /// Bind `addr` and serve until the process ends.
    ///
    /// Takes the address by value because the accept loop outlives the caller's
    /// borrow: it is spawned and never returns.
    pub async fn serve(self, addr: impl Into<String>) -> Result<(), ServerError> {
        self.bind(addr).await?.serve().await;
        Ok(())
    }
}

/// Lock the fallback slot, recovering from a poisoned lock.
///
/// A poisoned slot means some other thread panicked while holding it. The slot
/// only holds a binding, so the value is still usable; refusing to serve
/// afterwards would be a worse outcome than continuing.
fn lock_slot(
    slot: &FallbackSlot,
) -> std::sync::MutexGuard<'_, Option<ChannelFallbackBinding>> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Run one connection to completion.
pub async fn serve_connection<S>(
    stream: S,
    registry: Arc<ChannelRegistry>,
    config: SessionConfig,
    fallback: FallbackSlot,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let ws = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| format!("websocket handshake failed: {e}"))?;
    let (mut writer, mut reader) = ws.split();

    // Outbound frames are produced by handler threads, so they are funnelled
    // through a channel; only this task touches the socket's write half, which
    // keeps concurrent sends from interleaving frames.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    let writer_task = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            // The protocol is binary, so frames go out as binary messages. A
            // `Vec<u8>` must not be sent as text: tungstenite would encode it as
            // UTF-8 and corrupt anything that is not valid text.
            let message = tokio_tungstenite::tungstenite::Message::Binary(frame.into());
            if writer.send(message).await.is_err() {
                break;
            }
        }
    });

    let outbound = Arc::new(ChannelSink {
        sender: out_tx.clone(),
    });
    let config_pending_sweep_interval = config.pending_sweep_interval;
    let session = Session::new(registry, outbound, config);
    // Read the slot and drop the guard immediately; nothing is held across an
    // await, which is what makes the std mutex safe here.
    let binding = lock_slot(&fallback).clone();
    if let Some(binding) = binding {
        session.set_fallback(binding.fallback, binding.runtime);
    }

    // There is NO context handshake on this transport, and that is deliberate.
    //
    // The context prologue exists only in `IPCClient` (Electron's desktop→host
    // path). The browser/`connectViaWebSocket` client used by both the web app
    // and the Tauri renderer constructs a `ChannelClient` directly and never
    // sends one, and `@zcode/server` matches that by building its ChannelServer
    // with a fixed context. Treating the first frame as a context would swallow
    // the client's first real request and leave its promise unresolved forever.
    //
    // So: announce readiness immediately, then dispatch every frame.
    session.send_initialize();
    tracing::info!(
        ctx = %session.connection().ctx(),
        "rpc client connected"
    );

    let mut frames = FrameStream::new();

    // Deferred requests (for a channel that is not registered yet) are only
    // checked when a message arrives, which is not enough: a connection that
    // goes idle after such a request would never answer it and the client would
    // wait forever. Sweep on a timer so the deadline holds independently of
    // traffic. The interval is a quarter of the deadline, so a request is
    // answered within a quarter of its timeout at worst.
    let sweep = tokio::time::interval(config_pending_sweep_interval);
    let sweep_connection = Arc::clone(&session.connection());
    let sweeper = tokio::spawn(async move {
        let mut ticker = sweep;
        // The first tick completes immediately; skip it so startup does not spin.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            sweep_connection.flush_expired_pending();
        }
    });

    while let Some(message) = reader.next().await {
        let message = message.map_err(|e| format!("websocket receive failed: {e}"))?;
        use tokio_tungstenite::tungstenite::Message;
        let bytes = match message {
            Message::Binary(bytes) => bytes,
            Message::Close(_) => break,
            // The protocol is binary; a text frame cannot be a valid envelope.
            Message::Text(_) => continue,
            Message::Ping(payload) | Message::Pong(payload) => {
                // tungstenite answers pings itself on flush; nothing to do.
                let _ = payload;
                continue;
            }
            _ => continue,
        };

        let decoded = match frames.accept(&bytes) {
            Ok(decoded) => decoded,
            Err(error) => {
                // A framing violation desynchronises the stream, so the only safe
                // response is to drop the connection.
                return Err(format!("malformed transport frame: {error}"));
            }
        };

        for frame in decoded {
            session.on_frame(frame.message_type, &frame.payload);
        }
    }

    drop(out_tx);
    sweeper.abort();
    let _ = writer_task.await;
    Ok(())
}

/// An [`Outbound`] that hands frames to the socket's writer task.
struct ChannelSink {
    sender: mpsc::UnboundedSender<Vec<u8>>,
}

impl Outbound for ChannelSink {
    fn send(&self, payload: Vec<u8>) {
        // Wrap the channel payload in the transport frame here so no caller can
        // forget to.
        let _ = self.sender.send(write_regular(&payload));
    }
}

/// Wrap a channel payload in its transport frame. Exposed for hosts that manage
/// their own socket write path.
pub fn frame_payload(payload: &[u8]) -> Vec<u8> {
    write_regular(payload)
}

/// Encode an `Initialize` response payload (unframed).
pub fn initialize_payload() -> Vec<u8> {
    encode_response(&Response::initialize()).expect("initialize always encodes")
}
