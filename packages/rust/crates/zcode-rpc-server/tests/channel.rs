//! Behavioural tests for the channel server: routing, event pumping, error
//! mapping, cancellation, and the deferred-channel queue.
//!
//! The golden tests prove the bytes match the TypeScript implementation. These
//! prove the *semantics* match `ChannelServer` — that a request reaches the right
//! handler, that a failure comes back in the shape the client can rebuild, and
//! that a channel registered late still serves the calls made before it existed.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value as JsonValue;
use zcode_rpc_server::channel::{ChannelHandler, ChannelRegistry, HandlerError, Outbox};
use zcode_rpc_server::message::{decode_response, ResponseType};
use zcode_rpc_server::{Connection, RequestType, Session};

/// A test handler: answers `echo`, fails `boom`, and broadcasts `tick`.
struct TestHandler {
    /// Kept so the test can push events on demand.
    sender: crossbeam_channel::Sender<JsonValue>,
    /// Cloned into each subscription. crossbeam receivers are MPMC, so a clone
    /// shares the same queue rather than a fresh empty channel.
    receiver: crossbeam_channel::Receiver<JsonValue>,
    calls: AtomicUsize,
    seen: Mutex<Vec<String>>,
}

impl TestHandler {
    fn new() -> (Arc<Self>, crossbeam_channel::Sender<JsonValue>) {
        let (sender, receiver) = crossbeam_channel::unbounded();
        (
            Arc::new(Self {
                sender: sender.clone(),
                receiver,
                calls: AtomicUsize::new(0),
                seen: Mutex::new(Vec::new()),
            }),
            sender,
        )
    }
}

impl ChannelHandler for TestHandler {
    fn call(
        &self,
        _ctx: &str,
        method: &str,
        args: &[JsonValue],
    ) -> Result<JsonValue, HandlerError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.seen
            .lock()
            .expect("seen poisoned")
            .push(method.to_owned());
        match method {
            // A one-argument call arrives as a one-element positional list.
            "echo" => Ok(args.first().cloned().unwrap_or(JsonValue::Null)),
            "boom" => Err(HandlerError::with_code(
                "it exploded",
                JsonValue::String("E_BOOM".into()),
            )),
            "throwObject" => Err(HandlerError::Thrown(
                serde_json::json!({ "kind": "not-an-error" }),
            )),
            other => Err(HandlerError::message(format!("no such method: {other}"))),
        }
    }

    fn subscribe(
        &self,
        _ctx: &str,
        event: &str,
        _arg: Option<&JsonValue>,
    ) -> Option<crossbeam_channel::Receiver<JsonValue>> {
        if event != "tick" {
            return None;
        }
        Some(self.receiver.clone())
    }
}

/// Wait for the outbox to reach `count` messages, since handler calls are served
/// on their own thread.
fn wait_for(outbox: &Outbox, count: usize) -> Vec<Vec<u8>> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let messages = outbox.take();
        if messages.len() >= count {
            return messages;
        }
        if Instant::now() > deadline {
            panic!("timed out waiting for {count} messages, got {}", messages.len());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn setup() -> (
    Arc<ChannelRegistry>,
    Arc<Outbox>,
    Arc<TestHandler>,
    crossbeam_channel::Sender<JsonValue>,
) {
    let registry = Arc::new(ChannelRegistry::new());
    let outbox = Arc::new(Outbox::new());
    let (handler, receiver) = TestHandler::new();
    registry.register_shared("test", Arc::clone(&handler) as Arc<dyn ChannelHandler>);
    (registry, outbox, handler, receiver)
}

fn promise_call(channel: &str, method: &str, arg: Option<JsonValue>) -> Vec<u8> {
    zcode_rpc_server::encode_request(
        RequestType::Promise,
        1,
        Some(channel),
        Some(method),
        arg.as_ref(),
    )
    .expect("encode request")
}

#[test]
fn routes_a_promise_request_and_answers_with_success() {
    let (registry, outbox, _handler, _rx) = setup();
    let connection = Connection::new("test-ctx", registry, outbox.clone());
    connection.send_initialize();
    outbox.take();

    connection.on_message(&promise_call("test", "echo", Some(serde_json::json!({ "n": 5 }))));

    let messages = wait_for(&outbox, 1);
    let response = decode_response(&messages[0]).expect("decode response");
    assert_eq!(response.response_type, ResponseType::PromiseSuccess);
    assert_eq!(response.id, Some(1));
    assert_eq!(response.data, Some(serde_json::json!({ "n": 5 })));
}

#[test]
fn initialize_is_sent_with_no_id() {
    let (registry, outbox, _handler, _rx) = setup();
    let connection = Connection::new("test-ctx", registry, outbox.clone());
    connection.send_initialize();

    let messages = outbox.take();
    assert_eq!(messages.len(), 1);
    let response = decode_response(&messages[0]).expect("decode");
    assert_eq!(response.response_type, ResponseType::Initialize);
    assert_eq!(response.id, None, "Initialize carries no id");
}

#[test]
fn an_error_becomes_promise_error_with_the_passthrough_code() {
    let (registry, outbox, _handler, _rx) = setup();
    let connection = Connection::new("test-ctx", registry, outbox.clone());

    connection.on_message(&promise_call("test", "boom", None));

    let messages = wait_for(&outbox, 1);
    let response = decode_response(&messages[0]).expect("decode");
    assert_eq!(response.response_type, ResponseType::PromiseError);
    let data = response.data.expect("error body");
    assert_eq!(data["message"], "it exploded");
    assert_eq!(data["name"], "Error");
    assert_eq!(
        data["code"], "E_BOOM",
        "the client copies `code` onto the rebuilt Error, so it must survive"
    );
}

#[test]
fn a_non_error_rejection_becomes_promise_error_obj() {
    let (registry, outbox, _handler, _rx) = setup();
    let connection = Connection::new("test-ctx", registry, outbox.clone());

    connection.on_message(&promise_call("test", "throwObject", None));

    let messages = wait_for(&outbox, 1);
    let response = decode_response(&messages[0]).expect("decode");
    assert_eq!(response.response_type, ResponseType::PromiseErrorObj);
    assert_eq!(
        response.data.expect("body"),
        serde_json::json!({ "kind": "not-an-error" }),
        "a plain rejection value is forwarded verbatim, not wrapped"
    );
}

#[test]
fn an_explicit_null_result_is_distinguished_from_no_result() {
    let (registry, outbox, _handler, _rx) = setup();
    let connection = Connection::new("test-ctx", registry, outbox.clone());

    // `echo` with an explicit JSON null argument.
    connection.on_message(&promise_call("test", "echo", Some(JsonValue::Null)));

    let messages = wait_for(&outbox, 1);
    let response = decode_response(&messages[0]).expect("decode");
    // The handler returns `Null`; it must arrive as `Some(null)`, not as
    // `undefined`, or a service that legitimately returns null looks like it
    // returned nothing.
    assert_eq!(response.data, Some(JsonValue::Null));
}

#[test]
fn registers_the_context_on_the_connection() {
    let (registry, outbox, _handler, _rx) = setup();
    let connection = Connection::new("initial", registry, outbox);
    connection.set_ctx("from-handshake");
    assert_eq!(connection.ctx(), "from-handshake");
}

#[test]
fn a_call_for_a_channel_registered_later_is_replayed() {
    // Deliberately start with an EMPTY registry: the point is a call that
    // arrives before its channel exists.
    let registry = Arc::new(ChannelRegistry::new());
    let outbox = Arc::new(Outbox::new());
    let connection = Connection::new("test-ctx", Arc::clone(&registry), outbox.clone());
    assert!(registry.is_empty());

    // The channel does not exist yet, so the call must be deferred, not dropped.
    connection.on_message(&promise_call("test", "echo", Some(JsonValue::from("early"))));
    std::thread::sleep(Duration::from_millis(50));
    assert!(
        outbox.is_empty(),
        "a deferred call must not answer before its channel exists"
    );

    // Register it and let the server replay.
    let (handler, _sender) = TestHandler::new();
    registry.register_shared("test", Arc::clone(&handler) as Arc<dyn ChannelHandler>);
    connection.flush_pending_for("test");

    let messages = wait_for(&outbox, 1);
    let response = decode_response(&messages[0]).expect("decode");
    assert_eq!(response.response_type, ResponseType::PromiseSuccess);
    assert_eq!(response.data, Some(JsonValue::from("early")));
}

#[test]
fn an_event_subscription_pushes_frames_until_it_is_disposed() {
    let (registry, outbox, _handler, sender) = setup();
    let connection = Connection::new("test-ctx", registry, outbox.clone());

    connection.on_message(
        &zcode_rpc_server::encode_request(
            RequestType::EventListen,
            77,
            Some("test"),
            Some("tick"),
            None,
        )
        .expect("encode"),
    );

    sender.send(JsonValue::from("first")).expect("send");
    let messages = wait_for(&outbox, 1);
    let response = decode_response(&messages[0]).expect("decode");
    assert_eq!(response.response_type, ResponseType::EventFire);
    assert_eq!(response.id, Some(77), "the event id must match the subscription");
    assert_eq!(response.data, Some(JsonValue::from("first")));

    // Dispose, then push again: nothing more must be forwarded.
    connection.on_message(
        &zcode_rpc_server::encode_request(RequestType::EventDispose, 77, None, None, None)
            .expect("encode"),
    );
    std::thread::sleep(Duration::from_millis(120));
    let _ = outbox.take();

    sender.send(JsonValue::from("after-dispose")).expect("send");
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        outbox.is_empty(),
        "a disposed subscription must stop forwarding"
    );
}

#[test]
fn a_deferred_call_that_never_resolves_fails_instead_of_hanging() {
    let registry = Arc::new(ChannelRegistry::new());
    let outbox = Arc::new(Outbox::new());
    let connection = Connection::new("test-ctx", registry, outbox.clone());

    // Never registered: the deadline must produce a PromiseError, because the
    // client would otherwise wait forever on this id.
    connection.on_message(&promise_call("missing", "anything", None));
    connection.flush_expired_pending();
    // The deadline is one second; nothing should be answered yet.
    assert!(outbox.is_empty(), "must not fail before the deadline");

    std::thread::sleep(Duration::from_millis(1100));
    connection.flush_expired_pending();

    let messages = wait_for(&outbox, 1);
    let response = decode_response(&messages[0]).expect("decode");
    assert_eq!(response.response_type, ResponseType::PromiseError);
    let data = response.data.expect("body");
    assert_eq!(data["name"], "Unknown channel");
    assert!(
        data["message"].as_str().expect("message").contains("missing"),
        "the message must name the channel that never arrived"
    );
}

#[test]
fn an_undecodable_message_does_not_break_the_connection() {
    let (registry, outbox, _handler, _rx) = setup();
    let connection = Connection::new("test-ctx", registry, outbox.clone());

    // Garbage, then a valid request: the second must still be served.
    connection.on_message(&[0xff, 0xff, 0xff]);
    connection.on_message(&promise_call("test", "echo", Some(JsonValue::from("after"))));

    let messages = wait_for(&outbox, 1);
    let response = decode_response(&messages[0]).expect("decode");
    assert_eq!(response.response_type, ResponseType::PromiseSuccess);
    assert_eq!(response.data, Some(JsonValue::from("after")));
}

#[test]
fn the_handshake_sends_initialize_before_anything_else() {
    let (registry, outbox, _handler, _rx) = setup();
    let session = Session::new(registry, outbox.clone(), Default::default());

    // The client opens with a bare serialized ctx, not a channel envelope.
    let mut writer = zcode_codec::vql::VqlWriter::new();
    zcode_codec::serialization::serialize_option(&mut writer, Some(&JsonValue::from("main-window")))
        .expect("encode ctx");
    let ctx = session.handshake(&writer.into_bytes());

    assert_eq!(ctx.as_deref(), Some("main-window"));
    let messages = outbox.take();
    assert_eq!(messages.len(), 1, "exactly one frame after the handshake");
    let response = decode_response(&messages[0]).expect("decode");
    assert_eq!(
        response.response_type,
        ResponseType::Initialize,
        "the client blocks every request until Initialize, so it must be first"
    );
    assert_eq!(session.connection().ctx(), "main-window");
}

#[test]
fn a_handshake_payload_that_is_not_a_context_leaves_the_default() {
    let (registry, outbox, _handler, _rx) = setup();
    let session = Session::new(registry, outbox, Default::default());
    // An empty payload is not a decodable value.
    assert_eq!(session.handshake(&[]), None);
    assert_eq!(session.connection().ctx(), "server");
}
