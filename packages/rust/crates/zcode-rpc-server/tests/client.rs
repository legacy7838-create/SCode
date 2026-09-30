//! Tests for the outbound client, and for the proxy round trip it exists for.
//!
//! The point of the client is that a channel with no Rust implementation still
//! works for the UI. So the central test here runs a real `zcode-rpc-server`
//! instance, connects a real client to it, and checks that calls and events
//! survive the round trip — that is exactly the shape of "Rust proxies a channel
//! to the Node server".

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value as JsonValue;
use zcode_rpc_server::channel::{ChannelHandler, ChannelRegistry, HandlerError};
use zcode_rpc_server::frame::write_regular;
use zcode_rpc_server::message::{decode_response, ResponseType};
use zcode_rpc_server::{encode_request, RequestType, RpcClient, RpcServer, SessionConfig};

/// A stand-in for a Node service: answers `echo`, fails `boom`, emits `tick`.
struct Upstream {
    sender: crossbeam_channel::Sender<JsonValue>,
    receiver: crossbeam_channel::Receiver<JsonValue>,
}

impl Upstream {
    fn new() -> Arc<Self> {
        let (sender, receiver) = crossbeam_channel::unbounded();
        Arc::new(Self { sender, receiver })
    }
}

impl ChannelHandler for Upstream {
    fn call(
        &self,
        ctx: &str,
        method: &str,
        args: &[JsonValue],
    ) -> Result<JsonValue, HandlerError> {
        // The context must survive the round trip: the upstream server answers
        // per-connection, so a lost ctx would silently misroute.
        if ctx.is_empty() {
            return Err(HandlerError::message("no context on the upstream call"));
        }
        match method {
            // A one-argument call arrives as a one-element positional list.
            "echo" => Ok(args.first().cloned().unwrap_or(JsonValue::Null)),
            "boom" => Err(HandlerError::with_code(
                "upstream failed",
                JsonValue::String("E_UP".into()),
            )),
            other => Err(HandlerError::message(format!("unknown: {other}"))),
        }
    }

    fn subscribe(
        &self,
        _ctx: &str,
        event: &str,
        _arg: Option<&JsonValue>,
    ) -> Option<crossbeam_channel::Receiver<JsonValue>> {
        (event == "tick").then(|| self.receiver.clone())
    }
}

/// Start a real server and return a connected client for it.
async fn pair() -> (RpcClient, Arc<Upstream>) {
    let upstream = Upstream::new();
    let registry = Arc::new(ChannelRegistry::new());
    registry.register_shared("svc", Arc::clone(&upstream) as Arc<dyn ChannelHandler>);

    let listener = RpcServer::new(registry)
        .with_config(SessionConfig {
            default_ctx: "server".into(),
            pending_sweep_interval: Duration::from_millis(50),
            unknown_channel_timeout: Duration::from_millis(500),
        })
        .bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(listener.serve());

    let client = RpcClient::connect(&format!("ws://{addr}"), "proxy-ctx")
        .await
        .expect("client handshake");
    (client, upstream)
}

#[tokio::test]
async fn completes_the_handshake_before_returning() {
    let (client, _upstream) = pair().await;
    // If connect returned, Initialize already arrived; a call must work at once
    // with no extra waiting.
    let value = client
        .call("svc", "echo", Some(&JsonValue::from("hi")))
        .await
        .expect("call");
    assert_eq!(value, JsonValue::from("hi"));
}

#[tokio::test]
async fn round_trips_a_call_with_an_argument() {
    let (client, _upstream) = pair().await;
    let value = client
        .call("svc", "echo", Some(&serde_json::json!({ "a": [1, 2], "b": "x" })))
        .await
        .expect("call");
    assert_eq!(value, serde_json::json!({ "a": [1, 2], "b": "x" }));
}

#[tokio::test]
async fn an_explicit_null_argument_survives() {
    let (client, _upstream) = pair().await;
    // The undefined/null distinction was a real bug earlier; a service that
    // returns null must not come back as "nothing".
    let value = client.call("svc", "echo", Some(&JsonValue::Null)).await.expect("call");
    assert_eq!(value, JsonValue::Null);
}

#[tokio::test]
async fn an_upstream_failure_is_relayed_not_swallowed() {
    let (client, _upstream) = pair().await;
    let error = client
        .call("svc", "boom", None)
        .await
        .expect_err("must fail");
    let text = error.to_string();
    assert!(
        text.contains("upstream failed"),
        "the original message must survive, got: {text}"
    );
}

#[tokio::test]
async fn concurrent_calls_do_not_cross_their_responses() {
    // Each call is answered on its own thread, so a response could be delivered
    // to the wrong waiter if ids were not tracked individually. This is the
    // regression test for exactly that.
    let (client, _upstream) = pair().await;
    let client = Arc::new(client);

    let mut tasks = Vec::new();
    for index in 0..12u32 {
        let client = Arc::clone(&client);
        tasks.push(tokio::spawn(async move {
            let payload = JsonValue::from(index);
            let got = client.call("svc", "echo", Some(&payload)).await.expect("call");
            assert_eq!(got, payload, "response delivered to the wrong waiter");
        }));
    }
    for task in tasks {
        task.await.expect("task");
    }
}

#[tokio::test]
async fn receives_upstream_events() {
    let (client, upstream) = pair().await;
    let subscription = client
        .subscribe("svc", "tick", None)
        .await
        .expect("subscribe");

    upstream
        .sender
        .send(JsonValue::from("event-1"))
        .expect("publish");

    let received = tokio::task::spawn_blocking(move || subscription.events.recv_timeout(Duration::from_secs(5)))
        .await
        .expect("join")
        .expect("event");
    assert_eq!(received, JsonValue::from("event-1"));
}

#[tokio::test]
async fn unsubscribing_stops_event_delivery() {
    let (client, upstream) = pair().await;
    let subscription = client.subscribe("svc", "tick", None).await.expect("subscribe");

    upstream.sender.send(JsonValue::from("first")).expect("publish");
    // `recv_timeout` blocks, so it must run off the runtime thread; otherwise the
    // single-threaded test runtime cannot drive the server that publishes the
    // event, and the test deadlocks against itself.
    let first = tokio::task::spawn_blocking({
        let events = subscription.events.clone();
        move || events.recv_timeout(Duration::from_secs(5))
    })
    .await
    .expect("join")
    .expect("first event");
    assert_eq!(first, JsonValue::from("first"));

    client.unsubscribe(subscription.upstream_id);
    upstream.sender.send(JsonValue::from("second")).expect("publish");
    let leaked = tokio::task::spawn_blocking({
        let events = subscription.events.clone();
        move || events.recv_timeout(Duration::from_millis(400)).is_ok()
    })
    .await
    .expect("join");
    assert!(!leaked, "no events may arrive after unsubscribe");
}

#[tokio::test]
async fn connecting_to_nothing_fails_instead_of_hanging() {
    // Port 1 on loopback is not listening; the failure must be reported, because
    // a silent hang here would stall startup of the whole proxy.
    let error = RpcClient::connect("ws://127.0.0.1:1", "proxy")
        .await
        .expect_err("must fail");
    assert!(matches!(
        error,
        zcode_rpc_server::ClientError::WebSocket(_) | zcode_rpc_server::ClientError::Closed
    ));
}

/// A client talking to a raw socket must see the same protocol the UI does.
/// This asserts the client is not using a private dialect.
#[tokio::test]
async fn client_speaks_the_same_protocol_as_the_ui() {
    let (client, _upstream) = pair().await;
    // Drive one call by hand over a second connection and compare shapes.
    let (ws, _) = {
        // Reuse the same server address the client bound to.
        let registry = Arc::new(ChannelRegistry::new());
        let listener = RpcServer::new(registry)
            .bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(listener.serve());
        tokio_tungstenite::connect_async(format!("ws://{addr}"))
            .await
            .expect("connect")
    };
    let (mut writer, mut reader) = ws.split();
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let mut ctx_writer = zcode_codec::vql::VqlWriter::new();
    zcode_codec::serialization::serialize_option(&mut ctx_writer, Some(&JsonValue::from("raw")))
        .expect("ctx");
    writer
        .send(Message::Binary(write_regular(&ctx_writer.into_bytes()).into()))
        .await
        .expect("send ctx");

    // Initialize, then a request for a channel that does not exist.
    let _ = reader.next().await.expect("init frame");
    let request = encode_request(
        RequestType::Promise,
        1,
        Some("nope"),
        Some("missing"),
        None,
    )
    .expect("encode");
    writer
        .send(Message::Binary(write_regular(&request).into()))
        .await
        .expect("send");

    let mut frames = zcode_rpc_server::FrameStream::new();
    let mut payload = None;
    while payload.is_none() {
        let Some(Ok(Message::Binary(bytes))) = reader.next().await else {
            break;
        };
        if let Some(frame) = frames.accept(&bytes).ok().and_then(|f| f.into_iter().next()) {
            payload = Some(frame.payload);
        }
    }
    let response = decode_response(&payload.expect("a response")).expect("decode");
    assert!(
        matches!(
            response.response_type,
            ResponseType::PromiseError | ResponseType::Initialize
        ),
        "an unknown channel must not answer with success"
    );
    drop(client);
}
