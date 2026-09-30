//! zcode-rpc-server — an in-process implementation of the ZCode channel RPC
//! server for the Tauri host.
//!
//! # Why this exists
//!
//! The UI (`@zcode/ui`'s `<Root>`) needs an `IServiceAccessor`: the channel RPC
//! channel that carries every business service — files, git, settings, agent,
//! tasks. Today that channel is served by `@zcode/server`, a Node process. This
//! crate is the same protocol implemented natively, so the Tauri host can serve
//! the UI directly and the Node dependency can be retired service by service.
//!
//! # Protocol
//!
//! The wire format is *not* a new design; it is the existing one, byte for byte:
//!
//! ```text
//! transport: [type:1][id:4][ack:4][length:4]  big-endian, then `length` bytes
//! message:   serialize([type, id, channel, method]) + serialize(arg)
//! ```
//!
//! `zcode-codec` already implements the value serialization, so this crate only
//! adds the transport framing and the channel server. Compatibility is enforced
//! by `tests/golden.rs`, which asserts against vectors generated from the
//! TypeScript implementation by `scripts/gen-rpc-golden.ts`.
//!
//! # Layout
//!
//! * [`frame`] — transport framing and stream reassembly (`SocketProtocol`).
//! * [`message`] — request/response envelopes (`channelClient`/`channelServer`).
//! * [`channel`] — registry, routing, event pumping, deferred-channel queue.
//!//! * [`session`] — one client connection: handshake and frame dispatch.
//! * [`transport`] — the WebSocket accept loop that fronts the protocol core.
//! * [`client`] — the outbound half, used to forward unported channels to the
//!   Node server while they are migrated.

pub mod channel;
pub mod frame;
pub mod message;
pub mod session;
#[cfg(feature = "websocket")]
pub mod client;
#[cfg(feature = "websocket")]
pub mod proxy;
#[cfg(feature = "websocket")]
pub mod transport;

pub use channel::{
    ChannelFallback, ChannelHandler, ChannelRegistry, Connection, FallbackSubscription,
    HandlerError, Outbox, Outbound,
};
pub use frame::{write_frame, write_regular, Frame, FrameError, FrameStream, MessageType};
pub use message::{decode_request, decode_response, encode_request, encode_response};
pub use message::{Request, RequestType, Response, ResponseType};
pub use session::{Session, SessionConfig};
#[cfg(feature = "websocket")]
pub use client::{connect_local_server, ws_url, ClientError, RpcClient};
#[cfg(feature = "websocket")]
pub use proxy::ProxyFallback;
#[cfg(feature = "websocket")]
pub use transport::{ChannelFallbackBinding, FallbackSlot, RpcListener, RpcServer, ServerError};
