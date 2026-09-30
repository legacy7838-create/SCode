//! The migration seam: a channel with no Rust handler must still work for the UI.
//!
//! These tests wire two real servers together — a "Node" upstream and a "Tauri"
//! proxy in front of it — and talk to the proxy with the same protocol the UI
//! uses. That is the whole point of the proxy: the UI's single connection keeps
//! answering every channel while channels move to Rust one at a time, with no
//! change on the UI side and no window in which it breaks.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value as JsonValue;
use zcode_rpc_server::channel::{ChannelFallback, ChannelHandler, ChannelRegistry, HandlerError};
use zcode_rpc_server::{ClientError as RpcClientError, ProxyFallback, RpcClient, RpcServer, SessionConfig};

/// Stands in for a service that still lives in `@zcode/server`.
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
        _ctx: &str,
        method: &str,
        args: &[JsonValue],
    ) -> Result<JsonValue, HandlerError> {
        match method {
            // A one-argument call arrives as a one-element positional list.
            "echo" => Ok(args.first().cloned().unwrap_or(JsonValue::Null)),
            "boom" => Err(HandlerError::with_code(
                "upstream blew up",
                JsonValue::String("E_UP".into()),
            )),
            // Shaped like the credential channel's decrypt failure: a specific
            // code the UI branches on, which must survive the relay intact.
            "decryptFailed" => Err(HandlerError::with_code(
                "Failed to decrypt credential: key mismatch or corrupted ciphertext",
                JsonValue::String("ZCODE_CREDENTIAL_DECRYPT_FAILED".into()),
            )),
            other => Err(HandlerError::message(format!("unknown method: {other}"))),
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

struct Harness {
    /// Connected to the proxy, exactly as the UI would be.
    ui: RpcClient,
    /// The proxy's registry, so a test can make a channel native.
    proxy_registry: Arc<ChannelRegistry>,
    upstream: Arc<Upstream>,
    _proxy_addr: std::net::SocketAddr,
}

/// Start an upstream ("Node") server, then a proxy ("Tauri") in front of it.
async fn harness() -> Harness {
    let upstream_handler = Upstream::new();
    let upstream_registry = Arc::new(ChannelRegistry::new());
    upstream_registry.register_shared(
        "legacy",
        Arc::clone(&upstream_handler) as Arc<dyn ChannelHandler>,
    );
    let upstream_listener = RpcServer::new(upstream_registry)
        .with_config(SessionConfig {
            pending_sweep_interval: Duration::from_millis(50),
            ..Default::default()
        })
        .bind("127.0.0.1:0")
        .await
        .expect("upstream bind");
    let upstream_addr = upstream_listener.local_addr().expect("addr");
    tokio::spawn(upstream_listener.serve());

    // The proxy's client to the upstream server.
    let node_client = RpcClient::connect(&format!("ws://{upstream_addr}"), "tauri-proxy")
        .await
        .expect("proxy->upstream handshake");
    let fallback: Arc<dyn ChannelFallback> = Arc::new(ProxyFallback::new(Arc::new(node_client)));

    // The proxy ("Tauri") has an EMPTY registry: everything is proxied, which is
    // exactly the state during the migration.
    let proxy_registry = Arc::new(ChannelRegistry::new());
    let proxy_listener = RpcServer::new(Arc::clone(&proxy_registry))
        .with_config(SessionConfig {
            pending_sweep_interval: Duration::from_millis(50),
            unknown_channel_timeout: Duration::from_millis(700),
            ..Default::default()
        })
        .with_fallback(fallback, tokio::runtime::Handle::current())
        .bind("127.0.0.1:0")
        .await
        .expect("proxy bind");
    let proxy_addr = proxy_listener.local_addr().expect("addr");
    tokio::spawn(proxy_listener.serve());

    let ui = RpcClient::connect(&format!("ws://{proxy_addr}"), "ui")
        .await
        .expect("ui handshake");

    Harness {
        ui,
        proxy_registry,
        upstream: upstream_handler,
        _proxy_addr: proxy_addr,
    }
}

#[tokio::test]
async fn a_channel_with_no_rust_handler_is_proxied() {
    let h = harness().await;
    // The proxy has no "legacy" channel, yet the call must succeed by reaching
    // the upstream server. Without the fallback this would time out with
    // "Unknown channel" after the deadline.
    let value = h
        .ui
        .call("legacy", "echo", Some(&JsonValue::from("through-the-proxy")))
        .await
        .expect("proxied call");
    assert_eq!(value, JsonValue::from("through-the-proxy"));
}

#[tokio::test]
async fn a_proxied_call_with_no_argument_still_answers() {
    let h = harness().await;
    let value = h.ui.call("legacy", "echo", None).await.expect("proxied call");
    assert_eq!(value, JsonValue::Null);
}

#[tokio::test]
async fn a_proxied_failure_is_relayed_with_its_code() {
    let h = harness().await;
    let error = h
        .ui
        .call("legacy", "boom", None)
        .await
        .expect_err("must fail");
    let text = error.to_string();
    assert!(
        text.contains("upstream blew up"),
        "the upstream message must reach the UI, got: {text}"
    );
    // The upstream's own code must survive, not be replaced by a proxy code.
    let RpcClientError::RemoteCoded { code, .. } = &error else {
        panic!("the upstream code must survive the relay, got {error:?}");
    };
    assert_eq!(code, &JsonValue::String("E_UP".into()), "got {code}");
}

#[tokio::test]
async fn a_relayed_credential_decrypt_failure_keeps_its_code() {
    let h = harness().await;

    // `isCredentialDecryptError` in `packages/shared/src/oauth.ts:21` compares
    // `error.code` against a specific string and gives up as soon as it sees a
    // different one — there is no message fallback once a code is present. So a
    // relay that re-labelled this failure with its own proxy code would make an
    // unreadable login look like a transient fault: the app would retry forever
    // and the user would stay signed out with nothing to act on.
    let error = h
        .ui
        .call("legacy", "decryptFailed", Some(&JsonValue::Null))
        .await
        .expect_err("the upstream failure must propagate");

    let RpcClientError::RemoteCoded { message, code } = &error else {
        panic!("the decrypt code must survive the relay, got {error:?}");
    };
    assert_eq!(
        code,
        &JsonValue::String("ZCODE_CREDENTIAL_DECRYPT_FAILED".into()),
        "the code the UI branches on must not be overwritten"
    );
    assert!(
        message.starts_with("Failed to decrypt credential: "),
        "the message prefix is the fallback signal: {message}"
    );
}

#[tokio::test]
async fn registering_a_handler_takes_precedence_over_the_proxy() {
    let h = harness().await;

    // Prove it is proxied first.
    assert_eq!(
        h.ui
            .call("legacy", "echo", Some(&JsonValue::from("via-proxy")))
            .await
            .expect("call"),
        JsonValue::from("via-proxy")
    );

    // Now make "legacy" native on the proxy.
    struct Native;
    impl ChannelHandler for Native {
        fn call(
            &self,
            _ctx: &str,
            method: &str,
            args: &[JsonValue],
        ) -> Result<JsonValue, HandlerError> {
            let _ = method;
            Ok(args.first().cloned().unwrap_or(JsonValue::Null))
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
    h.proxy_registry
        .register_shared("legacy", Arc::new(Native) as Arc<dyn ChannelHandler>);

    // A local handler must win without any unregister step.
    assert_eq!(
        h.ui
            .call("legacy", "echo", Some(&JsonValue::from("via-native")))
            .await
            .expect("call"),
        JsonValue::from("via-native")
    );
}

#[tokio::test]
async fn a_proxied_event_reaches_the_ui() {
    let h = harness().await;
    let subscription = h
        .ui
        .subscribe("legacy", "tick", None)
        .await
        .expect("proxied subscribe");

    h.upstream.sender.send(JsonValue::from("tick-1")).expect("publish");

    let received = tokio::task::spawn_blocking({
        let events = subscription.events.clone();
        move || events.recv_timeout(Duration::from_secs(5))
    })
    .await
    .expect("join")
    .expect("event");
    assert_eq!(received, JsonValue::from("tick-1"));
}

#[tokio::test]
async fn disposing_a_proxied_subscription_stops_the_relay() {
    let h = harness().await;
    let subscription = h
        .ui
        .subscribe("legacy", "tick", None)
        .await
        .expect("proxied subscribe");

    h.upstream.sender.send(JsonValue::from("before")).expect("publish");
    let first = tokio::task::spawn_blocking({
        let events = subscription.events.clone();
        move || events.recv_timeout(Duration::from_secs(5))
    })
    .await
    .expect("join")
    .expect("first event");
    assert_eq!(first, JsonValue::from("before"));

    h.ui.unsubscribe(subscription.upstream_id);
    h.upstream.sender.send(JsonValue::from("after")).expect("publish");

    // Give the relay a moment, then confirm nothing arrives.
    let leaked = tokio::task::spawn_blocking({
        let events = subscription.events.clone();
        move || events.recv_timeout(Duration::from_millis(500)).is_ok()
    })
    .await
    .expect("join");
    assert!(!leaked, "a disposed proxied subscription must stop relaying");
}
