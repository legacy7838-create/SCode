//! RPC client — the mirror of the server, used to forward channels this host has
//! not ported yet.
//!
//! # Why
//!
//! The UI takes a single `IServiceAccessor`, so it can only hold one service
//! connection. Migrating a channel to Rust means the Rust host must *own* that
//! connection and answer every channel itself — including the ones still
//! implemented in TypeScript. So for a channel with no local handler, the request
//! is forwarded to `@zcode/server` and the answer is relayed back. Channels move
//! from "proxied" to "native" one at a time, and nothing the UI does changes in
//! between.
//!
//! This is deliberately the same wire protocol as the server, in the other
//! direction. The framing, the envelope, and the handshake are reused verbatim,
//! so there is no second dialect to keep in sync.
//!
//! # Handshake
//!
//! Identical to what the UI does, and for the same reason: the first message is
//! the context, and no request may be sent until `Initialize` comes back.
//! `connect` returns only after that, so callers never have to buffer.
//!
//! # Identifier translation
//!
//! The UI numbers its requests, and this client numbers its own requests to the
//! upstream server. Those two spaces are independent, so responses and event
//! frames are translated on the way back. Without that, an `EventFire` for an
//! upstream id would be delivered to the wrong UI subscription.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value as JsonValue;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::frame::{write_regular, FrameStream};
use crate::message::{
    decode_response, encode_request, RequestType, Response, ResponseType,
};
use crate::frame::MessageType;

/// Client-side failures.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("websocket error: {0}")]
    WebSocket(String),
    #[error("the connection closed before the request completed")]
    Closed,
    #[error("upstream did not send Initialize")]
    NoInitialize,
    #[error("upstream sent a response for an unknown request id {0}")]
    UnknownId(u32),
    #[error("timed out after {0}ms waiting for the upstream server")]
    Timeout(u64),
    #[error("upstream returned an error: {0}")]
    Remote(String),
    /// An upstream failure that carried a machine-readable `code`.
    ///
    /// Kept separate from [`ClientError::Remote`] because the code is
    /// load-bearing, not decoration. The UI's `isCredentialDecryptError` returns
    /// false the moment it sees a *different* code, so an upstream decrypt
    /// failure relayed as a bare message — or re-wrapped with a proxy code —
    /// stops being recognisable as a decrypt failure, and the user is left
    /// signed out while the app retries a failure that can never succeed.
    #[error("upstream returned an error: {message}")]
    RemoteCoded { message: String, code: JsonValue },
}

/// How long to wait for an upstream call before giving up.
///
/// Deliberately longer than the server's own one-second deferred-channel
/// deadline: this client sits behind a real network hop plus a real handler, so
/// a short timeout here would turn slow-but-working services into failures.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// An event subscription on the upstream server.
pub struct UpstreamSubscription {
    /// Frames to relay to the UI: the payload of each `EventFire`.
    pub events: crossbeam_channel::Receiver<JsonValue>,
    /// Id the upstream knows this subscription by; used to unsubscribe.
    pub upstream_id: u32,
}

/// A connected client for one upstream server.
pub struct RpcClient {
    /// Envelope payloads to be framed and written. Owned by the writer task.
    tx: mpsc::UnboundedSender<Vec<u8>>,
    /// In-flight promise requests, keyed by the id we sent upstream.
    pending: Arc<Mutex<HashMap<u32, oneshot::Sender<Result<JsonValue, ClientError>>>>>,
    /// Upstream event id → the receiver to deliver frames to.
    listeners: Arc<Mutex<HashMap<u32, crossbeam_channel::Sender<JsonValue>>>>,
    next_id: Arc<AtomicU32>,
    /// Tasks this connection owns, aborted together on drop.
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl RpcClient {
    /// Connect and complete the handshake.
    ///
    /// Resolves only after `Initialize`, so the returned client is immediately
    /// usable — no caller-side request buffering needed.
    pub async fn connect(url: &str, ctx: &str) -> Result<Self, ClientError> {
        let (stream, _) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|error| ClientError::WebSocket(error.to_string()))?;
        Self::from_upgraded(stream, ctx).await
    }

    /// Build a client over an already-upgraded WebSocket stream.
    ///
    /// The handshake is already done at this layer, so the only thing left is the
    /// channel protocol: send the context, then wait for `Initialize`.
    pub async fn from_upgraded<S>(ws: WebSocketStream<S>, ctx: &str) -> Result<Self, ClientError>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let (mut writer, mut reader) = ws.split();

        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let pending: Arc<Mutex<HashMap<u32, oneshot::Sender<Result<JsonValue, ClientError>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let listeners: Arc<Mutex<HashMap<u32, crossbeam_channel::Sender<JsonValue>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // Writer task: the only place that touches the write half, so concurrent
        // sends cannot interleave frames.
        let writer_task = tokio::spawn(async move {
            while let Some(payload) = rx.recv().await {
                let message = Message::Binary(write_regular(&payload).into());
                if writer.send(message).await.is_err() {
                    break;
                }
            }
        });

        // Reader task: dispatch Initialize, promise responses, and event frames.
        let (ready_tx, ready_rx) = oneshot::channel::<Result<(), ClientError>>();
        let pending_for_reader = Arc::clone(&pending);
        let listeners_for_reader = Arc::clone(&listeners);
        let reader_task = tokio::spawn(async move {
            let mut frames = FrameStream::new();
            let mut initialized = false;
            // A first message that is not a frame means the peer is not speaking
            // this protocol; failing here is clearer than timing out later.
            let mut ready_tx = Some(ready_tx);

            while let Some(message) = reader.next().await {
                let Ok(message) = message else { break };
                let bytes = match message {
                    Message::Binary(bytes) => bytes,
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(decoded) = frames.accept(&bytes) else {
                    break;
                };

                for frame in decoded {
                    if frame.message_type != MessageType::Regular {
                        continue;
                    }
                    let Ok(response) = decode_response(&frame.payload) else {
                        continue;
                    };

                    match response.response_type {
                        ResponseType::Initialize => {
                            if let Some(tx) = ready_tx.take() {
                                let _ = tx.send(Ok(()));
                            }
                            initialized = true;
                        }
                        ResponseType::PromiseSuccess | ResponseType::PromiseError
                        | ResponseType::PromiseErrorObj => {
                            let Some(id) = response.id else { continue };
                            let Some(responder) = pending_for_reader
                                .lock()
                                .expect("pending poisoned")
                                .remove(&id)
                            else {
                                continue;
                            };
                            let outcome = match response.response_type {
                                ResponseType::PromiseSuccess => {
                                    Ok(response.data.unwrap_or(JsonValue::Null))
                                }
                                // Re-raise the upstream failure, preserving its
                                // `code` when it has one so the relay does not
                                // strip the signal the UI branches on.
                                _ => Err(match response.data.as_ref().and_then(|data| data.get("code")) {
                                    Some(code) => ClientError::RemoteCoded {
                                        message: error_text(&response.data),
                                        code: code.clone(),
                                    },
                                    None => ClientError::Remote(error_text(&response.data)),
                                }),
                            };
                            let _ = responder.send(outcome);
                        }
                        ResponseType::EventFire => {
                            let Some(id) = response.id else { continue };
                            let Some(target) = listeners_for_reader
                                .lock()
                                .expect("listeners poisoned")
                                .get(&id)
                                .cloned()
                            else {
                                continue;
                            };
                            let _ = target.send(response.data.unwrap_or(JsonValue::Null));
                        }
                    }
                }
            }

            // The socket ended: everything waiting will never be answered.
            let mut guard = pending_for_reader.lock().expect("pending poisoned");
            for (_, responder) in guard.drain() {
                let _ = responder.send(Err(ClientError::Closed));
            }
            drop(guard);
            let mut guard = listeners_for_reader.lock().expect("listeners poisoned");
            guard.clear();

            if let Some(tx) = ready_tx.take() {
                let _ = tx.send(Err(ClientError::NoInitialize));
            }
            let _ = initialized;
        });

        let client = Self {
            tx,
            pending,
            listeners,
            next_id: Arc::new(AtomicU32::new(1)),
            tasks: Mutex::new(vec![writer_task, reader_task]),
        };

        // Handshake: context first, then wait for Initialize.
        let mut ctx_writer = zcode_codec::vql::VqlWriter::new();
        zcode_codec::serialization::serialize_option(&mut ctx_writer, Some(&JsonValue::from(ctx)))
            .map_err(|error| ClientError::WebSocket(error.to_string()))?;
        client
            .tx
            .send(ctx_writer.into_bytes())
            .map_err(|_| ClientError::Closed)?;

        match tokio::time::timeout(REQUEST_TIMEOUT, ready_rx).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(error))) => return Err(error),
            Ok(Err(_)) => return Err(ClientError::NoInitialize),
            Err(_) => return Err(ClientError::Timeout(REQUEST_TIMEOUT.as_millis() as u64)),
        }

        // The writer task must live as long as the client; the reader task ends
        // on its own when the socket closes. Both are aborted on drop.
        Ok(client)
    }

    /// Call a method on the upstream server.
    pub async fn call(
        &self,
        channel: &str,
        method: &str,
        arg: Option<&JsonValue>,
    ) -> Result<JsonValue, ClientError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (responder, receiver) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending poisoned")
            .insert(id, responder);

        let payload = encode_request(
            RequestType::Promise,
            id,
            Some(channel),
            Some(method),
            arg,
        )
        .map_err(|error| ClientError::WebSocket(error.to_string()))?;

        if self.tx.send(payload).is_err() {
            self.pending
                .lock()
                .expect("pending poisoned")
                .remove(&id);
            return Err(ClientError::Closed);
        }

        match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err(ClientError::Closed),
            Err(_) => {
                // Drop the entry so a late response does not leak the map.
                self.pending
                    .lock()
                    .expect("pending poisoned")
                    .remove(&id);
                Err(ClientError::Timeout(REQUEST_TIMEOUT.as_millis() as u64))
            }
        }
    }

    /// Subscribe to an upstream event.
    pub async fn subscribe(
        &self,
        channel: &str,
        event: &str,
        arg: Option<&JsonValue>,
    ) -> Result<UpstreamSubscription, ClientError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = crossbeam_channel::unbounded();
        self.listeners
            .lock()
            .expect("listeners poisoned")
            .insert(id, sender);

        let payload = encode_request(RequestType::EventListen, id, Some(channel), Some(event), arg)
            .map_err(|error| ClientError::WebSocket(error.to_string()))?;
        if self.tx.send(payload).is_err() {
            self.listeners
                .lock()
                .expect("listeners poisoned")
                .remove(&id);
            return Err(ClientError::Closed);
        }

        Ok(UpstreamSubscription {
            events: receiver,
            upstream_id: id,
        })
    }

    /// Cancel an upstream event subscription.
    pub fn unsubscribe(&self, upstream_id: u32) {
        self.listeners
            .lock()
            .expect("listeners poisoned")
            .remove(&upstream_id);
        if let Ok(payload) = encode_request(RequestType::EventDispose, upstream_id, None, None, None) {
            let _ = self.tx.send(payload);
        }
    }

    /// Send a raw envelope, for hosts that need an exact response frame.
    pub fn send_raw(&self, payload: Vec<u8>) -> Result<(), ClientError> {
        self.tx.send(payload).map_err(|_| ClientError::Closed)
    }

    /// Encode a response envelope without sending it.
    pub fn encode(response: &Response) -> Result<Vec<u8>, ClientError> {
        crate::message::encode_response(response)
            .map_err(|error| ClientError::WebSocket(error.to_string()))
    }
}

impl std::fmt::Debug for RpcClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RpcClient")
            .field("in_flight", &self.pending.lock().map(|p| p.len()).ok())
            .field("listeners", &self.listeners.lock().map(|l| l.len()).ok())
            .finish()
    }
}

impl Drop for RpcClient {
    fn drop(&mut self) {
        for handle in self.tasks.lock().expect("tasks poisoned").drain(..) {
            handle.abort();
        }
    }
}

/// Flatten an upstream error payload into a single line.
fn error_text(data: &Option<JsonValue>) -> String {
    match data {
        Some(JsonValue::String(text)) => text.clone(),
        Some(value) => value
            .get("message")
            .and_then(JsonValue::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string()),
        None => "upstream error".to_owned(),
    }
}

/// Convenience for building a WebSocket URL from a host and port.
pub fn ws_url(host: &str, port: u16, path: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("ws://[{host}]:{port}{path}")
    } else {
        format!("ws://{host}:{port}{path}")
    }
}

/// Open a client to a local `@zcode/server`.
///
/// The `/ws` path is the terminal-client endpoint, which is the same mode the
/// web client uses and needs no capability handshake. The desktop's
/// `/ws/host` mode additionally unlocks provider provisioning, which is not
/// needed to forward channels and would require a capability round trip.
pub async fn connect_local_server(port: u16) -> Result<RpcClient, ClientError> {
    RpcClient::connect(&ws_url("127.0.0.1", port, "/ws"), "tauri-proxy").await
}
