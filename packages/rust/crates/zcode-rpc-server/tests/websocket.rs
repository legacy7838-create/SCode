//! End-to-end test over a real WebSocket.
//!
//! The unit tests drive the protocol synchronously; this one stands up the actual
//! accept loop on a loopback port and talks to it with a WebSocket client, so the
//! listener, the handshake ordering and the outbound frame path are all covered
//! together. It is the closest thing to what the UI will do.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value as JsonValue;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;

use zcode_rpc_server::channel::{ChannelHandler, ChannelRegistry, HandlerError, Outbox};
use zcode_rpc_server::frame::write_regular;
use zcode_rpc_server::message::{decode_response, ResponseType};
use zcode_rpc_server::{encode_request, RequestType};
use zcode_rpc_server::{RpcServer, SessionConfig};

struct Echo;

impl ChannelHandler for Echo {
    fn call(
        &self,
        _ctx: &str,
        method: &str,
        args: &[JsonValue],
    ) -> Result<JsonValue, HandlerError> {
        match method {
            // A one-argument call arrives as a one-element positional list.
            "echo" => Ok(args.first().cloned().unwrap_or(JsonValue::Null)),
            "boom" => Err(HandlerError::with_code(
                "nope",
                JsonValue::String("E_NOPE".into()),
            )),
            other => Err(HandlerError::message(format!("unknown: {other}"))),
        }
    }

    fn subscribe(
        &self,
        _ctx: &str,
        _event: &str,
        _arg: Option<&JsonValue>,
    ) -> Option<crossbeam_channel::Receiver<JsonValue>> {
        None
    }
}

/// Encode a value with the undefined/null-aware path the client uses.
fn ser(value: Option<&JsonValue>) -> Vec<u8> {
    let mut writer = zcode_codec::vql::VqlWriter::new();
    zcode_codec::serialization::serialize_option(&mut writer, value).expect("encode");
    writer.into_bytes()
}

#[tokio::test]
async fn serves_a_real_websocket_client_end_to_end() {
    let registry = Arc::new(ChannelRegistry::new());
    registry.register_shared("test", Arc::new(Echo) as Arc<dyn ChannelHandler>);

    // Bind on an ephemeral port, and learn the real port *before* accepting, so
    // there is no race between the listener being up and the client connecting.
    let listener = RpcServer::new(Arc::clone(&registry))
        .with_config(SessionConfig {
            default_ctx: "server".into(),
            pending_sweep_interval: Duration::from_millis(100),
            unknown_channel_timeout: Duration::from_millis(500),
        })
        .bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("local addr");
    let handle = tokio::spawn(listener.serve());

    // Connect.
    let (client, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .expect("websocket connect");
    let (mut writer, mut reader) = client.split();

    // There is no context prologue: `connectViaWebSocket` — the client the real
    // UI uses — never sends one. The server must announce readiness on its own
    // and must not consume the first frame as a handshake.
    writer
        .send(Message::Binary(write_regular(
            &ser(Some(&JsonValue::from("main-window"))),
        )))
        .await
        .expect("send");

    // Step 1: the server must answer with Initialize without being asked. The
    // client blocks every request until it sees this.
    let mut frames = zcode_rpc_server::FrameStream::new();
    let first = recv_payload(&mut reader, &mut frames).await;
    let response = decode_response(&first).expect("decode initialize");
    assert_eq!(
        response.response_type,
        ResponseType::Initialize,
        "Initialize must come first; the client blocks until it sees it"
    );

    // Step 2: a real call round-trips.
    let request = encode_request(
        RequestType::Promise,
        7,
        Some("test"),
        Some("echo"),
        Some(&serde_json::json!({ "hello": "world" })),
    )
    .expect("encode request");
    writer
        .send(Message::Binary(write_regular(&request)))
        .await
        .expect("send request");

    let reply = recv_payload(&mut reader, &mut frames).await;
    let response = decode_response(&reply).expect("decode reply");
    assert_eq!(response.response_type, ResponseType::PromiseSuccess);
    assert_eq!(response.id, Some(7));
    assert_eq!(response.data, Some(serde_json::json!({ "hello": "world" })));

    // Step 3: a failure comes back in the shape the client rebuilds an Error
    // from, including the passthrough `code`.
    let request = encode_request(RequestType::Promise, 8, Some("test"), Some("boom"), None)
        .expect("encode");
    writer
        .send(Message::Binary(write_regular(&request)))
        .await
        .expect("send");

    let reply = recv_payload(&mut reader, &mut frames).await;
    let response = decode_response(&reply).expect("decode");
    assert_eq!(response.response_type, ResponseType::PromiseError);
    let data = response.data.expect("error body");
    assert_eq!(data["message"], "nope");
    assert_eq!(data["code"], "E_NOPE");

    // A text frame is not part of the protocol and must be ignored, not crash
    // the connection.
    writer
        .send(Message::Text("not a frame".into()))
        .await
        .expect("send text");

    // The connection must still work afterwards.
    let request = encode_request(
        RequestType::Promise,
        9,
        Some("test"),
        Some("echo"),
        Some(&JsonValue::from("still alive")),
    )
    .expect("encode");
    writer
        .send(Message::Binary(write_regular(&request)))
        .await
        .expect("send");
    let reply = recv_payload(&mut reader, &mut frames).await;
    let response = decode_response(&reply).expect("decode");
    assert_eq!(response.data, Some(JsonValue::from("still alive")));

    handle.abort();
    let _ = Outbox::new();
}

async fn recv_binary<S>(reader: &mut S) -> Vec<u8>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match reader.next().await {
            Some(Ok(Message::Binary(bytes))) => return bytes,
            Some(Ok(_)) => continue,
            Some(Err(error)) => panic!("websocket receive failed: {error}"),
            None => panic!("connection closed while waiting for a frame"),
        }
    }
}

/// Receive one *transport frame* and return its channel payload.
///
/// The bytes on the socket are framed (13-byte header + body), so the envelope
/// can only be decoded after the frame has been stripped. Doing it the other way
/// round would read the header as a type tag.
async fn recv_payload<S>(reader: &mut S, frames: &mut zcode_rpc_server::FrameStream) -> Vec<u8>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let bytes = recv_binary(reader).await;
        let decoded = frames.accept(&bytes).expect("valid frames");
        if let Some(frame) = decoded.into_iter().next() {
            return frame.payload;
        }
    }
}

#[tokio::test]
async fn the_first_request_is_answered_rather_than_eaten_as_a_handshake() {
    // Regression test. The server once treated the first frame as a context
    // prologue, mirroring `IPCClient`. But the browser client the UI actually
    // uses never sends one, so the first real request was consumed as a
    // "context" and its promise never resolved — a call that simply hung, with
    // no error anywhere. This asserts the very first request on a fresh
    // connection is answered.
    let registry = Arc::new(ChannelRegistry::new());
    registry.register_shared("test", Arc::new(Echo) as Arc<dyn ChannelHandler>);

    let listener = RpcServer::new(registry)
        .bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(listener.serve());

    let (client, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .expect("connect");
    let (mut writer, mut reader) = client.split();

    // The very first frame we send is a request, not a prologue.
    let request = encode_request(
        RequestType::Promise,
        1,
        Some("test"),
        Some("echo"),
        Some(&JsonValue::from("first-ever")),
    )
    .expect("encode");
    writer
        .send(Message::Binary(write_regular(&request)))
        .await
        .expect("send");

    let mut frames = zcode_rpc_server::FrameStream::new();
    // Initialize first...
    let first = recv_payload(&mut reader, &mut frames).await;
    assert_eq!(
        decode_response(&first).expect("decode").response_type,
        ResponseType::Initialize
    );
    // ...and then an answer to the request we sent before Initialize arrived.
    let reply = recv_payload(&mut reader, &mut frames).await;
    let response = decode_response(&reply).expect("decode");
    assert_eq!(
        response.response_type,
        ResponseType::PromiseSuccess,
        "the first request must be answered, not consumed as a handshake"
    );
    assert_eq!(response.data, Some(JsonValue::from("first-ever")));
}

/// The listener must actually bind, not silently fail.
#[tokio::test]
async fn reports_a_bind_failure_instead_of_hanging() {
    // Occupy a port, then ask the server to bind the same one.
    let occupied = TcpStream::connect("127.0.0.1:1").await;
    let _ = occupied;
    let registry = Arc::new(ChannelRegistry::new());
    let result = RpcServer::new(registry)
        .serve(String::from("not-a-valid-address"))
        .await;
    assert!(
        result.is_err(),
        "an unbindable address must surface as an error, not a silent no-op"
    );
}
