//! Connection session — readiness and frame dispatch.
//!
//! # There is no client→server context prologue on this transport
//!
//! The prologue exists only in `IPCClient` (Electron's desktop→host path). The
//! browser client that both the web app and the Tauri renderer use,
//! `connectViaWebSocket`, builds a `ChannelClient` directly and never sends a
//! context — and `@zcode/server` matches that by constructing its
//! `ChannelServer` with a fixed context string.
//!
//! So the transport announces readiness immediately and dispatches every frame.
//! A server that expected a prologue would consume the client's *first real
//! request* as if it were a context and leave that request's promise unresolved
//! forever, which is silent: no error, just a call that never returns.
//! [`Session::handshake`] remains for the `IPCClient` shape, where the peer does
//! identify itself.
//!
//! # Ordering
//!
//! `Initialize` is written before the first frame is read, mirroring
//! `ChannelServer`'s `deferInit = false`. The client holds every request until it
//! sees that frame, so a request can never race ahead of readiness.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value as JsonValue;
use zcode_codec::serialization::deserialize;
use zcode_codec::vql::VqlReader;

use crate::channel::{ChannelRegistry, Connection, Outbound};
use crate::frame::{write_regular, FrameStream, MessageType};
use crate::message::Response;

/// How a session should behave.
#[derive(Debug, Clone)]
pub struct SessionConfig {
    /// Identity used when the client does not send a usable `ctx`.
    pub default_ctx: String,
    /// How often the server re-checks for expired deferred requests.
    pub pending_sweep_interval: Duration,
    /// The deadline applied to a request whose channel is not registered yet.
    pub unknown_channel_timeout: Duration,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            default_ctx: "server".to_owned(),
            pending_sweep_interval: Duration::from_millis(250),
            unknown_channel_timeout: crate::channel::UNKNOWN_CHANNEL_TIMEOUT,
        }
    }
}

/// A single client connection.
///
/// The transport is abstracted as "callbacks deliver bytes, bytes go out", so
/// this type works over a WebSocket, a `std::os::unix::net::UnixStream`, or an
/// in-process channel without knowing which.
pub struct Session {
    connection: Arc<Connection>,
    config: SessionConfig,
}

impl Session {
    pub fn new(
        registry: Arc<ChannelRegistry>,
        outbound: Arc<dyn Outbound>,
        config: SessionConfig,
    ) -> Self {
        Self {
            connection: Arc::new(Connection::new(
                config.default_ctx.clone(),
                registry,
                outbound,
            )),
            config,
        }
    }

    pub fn connection(&self) -> &Arc<Connection> {
        &self.connection
    }

    /// Forward channels that have no local handler upstream.
    ///
    /// Applied to this session's connection immediately, so it takes effect for
    /// the very next request on the wire.
    pub fn set_fallback(
        &self,
        fallback: Arc<dyn crate::channel::ChannelFallback>,
        runtime: tokio::runtime::Handle,
    ) {
        self.connection.set_fallback(fallback, runtime);
    }

    /// Announce readiness. Must be the first frame on a connection.
    ///
    /// The client queues every request until it receives this.
    pub fn send_initialize(&self) {
        self.connection.send_initialize();
    }

    /// Complete a context prologue, for callers whose client sends one.
    ///
    /// The WebSocket transport does **not** use this — see the module notes.
    /// Returns the context the client identified as, or `None` if the first
    /// message was not a decodable context value.
    pub fn handshake(&self, first_payload: &[u8]) -> Option<String> {
        let mut reader = VqlReader::new(first_payload);
        let value = deserialize(&mut reader).ok()?;
        let ctx = match value {
            JsonValue::String(text) => text,
            // A non-string ctx is legal (TContext is generic) but the desktop
            // host only ever uses strings; keep something addressable.
            other => other.to_string(),
        };
        let ctx = if ctx.is_empty() {
            self.config.default_ctx.clone()
        } else {
            ctx
        };
        self.connection.set_ctx(&ctx);
        self.connection.send_initialize();
        Some(ctx)
    }

    /// Feed raw transport bytes, handling framing and dispatch.
    pub fn on_transport_bytes(&self, bytes: &[u8]) {
        let mut stream = FrameStream::new();
        match stream.accept(bytes) {
            Ok(frames) => {
                for frame in frames {
                    self.on_frame(frame.message_type, &frame.payload);
                }
            }
            Err(error) => {
                tracing::warn!(%error, "dropping malformed transport bytes");
            }
        }
    }

    /// Handle one decoded transport frame.
    ///
    /// Public so a transport can drive the session directly after the handshake
    /// instead of funnelling every frame back through
    /// [`Session::on_transport_bytes`] and re-running the framer.
    pub fn on_frame(&self, message_type: MessageType, payload: &[u8]) {
        match message_type {
            MessageType::Regular => {
                self.connection.on_message(payload);
                self.connection.flush_expired_pending();
            }
            // The in-process server does not implement the persistent protocol,
            // so ACK/keepalive frames are inert here rather than an error.
            MessageType::Ack | MessageType::KeepAlive | MessageType::Control => {}
            MessageType::Disconnect => {
                tracing::debug!("peer sent a Disconnect frame");
            }
            MessageType::None | MessageType::ReplayRequest | MessageType::Pause | MessageType::Resume => {
                tracing::debug!(?message_type, "ignoring unsupported frame type");
            }
        }
    }

    /// Encode an `Initialize` frame. Exposed for tests and for a host that wants
    /// to send the handshake itself.
    pub fn initialize_frame() -> Vec<u8> {
        write_regular(
            &crate::message::encode_response(&Response::initialize()).expect("initialize encodes"),
        )
    }
}
