//! Wire-level check that arguments and errors survive the client → server path.
//!
//! `probeIntranet` receives an object, so this exercises a path a unit test
//! cannot: the argument is serialised by the Rust client, framed, parsed by the
//! Rust decoder, and handed to the handler. A handler-only test would pass even
//! if the argument were dropped in transit.
//!
//! The credential cases are here for the same reason, and they matter more: the
//! `save` call takes two positional arguments, and reading the value from the
//! first one is exactly the bug that made every `load` return the key instead of
//! the secret. Nothing but a real round trip over the wire can prove the second
//! argument arrives in the second position.

use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::{json, Value as JsonValue};
use zcode_tauri_lib::rpc::RpcHost;

/// Redirects `$HOME` for as long as it is alive, and restores it exactly on
/// drop.
///
/// A guard rather than a wrapper closure, because the environment has to stay
/// redirected across every `await` in the test: a nested `block_on` would panic,
/// and restoring `$HOME` before the server had read it would point the test at
/// the developer's real credential store.
///
/// The lock is held for the guard's lifetime because `$HOME` is process-global
/// and the test harness runs tests on threads.
struct IsolatedHome {
    _guard: std::sync::MutexGuard<'static, ()>,
    previous_home: Option<String>,
    previous_base: Option<String>,
    dir: PathBuf,
}

impl IsolatedHome {
    fn new(label: &str) -> Self {
        static LOCK: StdMutex<()> = StdMutex::new(());
        let guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        let previous_home = std::env::var("HOME").ok();
        let previous_base = std::env::var("ZCODE_DATA_BASE_DIR").ok();

        let dir = std::env::temp_dir().join(format!("zcode-wire-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp home");
        std::env::set_var("HOME", &dir);
        // Explicitly cleared: an inherited `ZCODE_DATA_BASE_DIR` would send the
        // store somewhere else, and the assertions would pass while checking
        // nothing about the code under test.
        std::env::remove_var("ZCODE_DATA_BASE_DIR");

        Self {
            _guard: guard,
            previous_home,
            previous_base,
            dir,
        }
    }

    fn store_path(&self) -> PathBuf {
        self.dir.join(".zcode").join("v2").join("credentials.json")
    }
}

impl Drop for IsolatedHome {
    fn drop(&mut self) {
        // Restore exactly, including unsetting a variable that was not set.
        // Leaving `HOME=""` behind is not the same as leaving it absent.
        match self.previous_home.take() {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        match self.previous_base.take() {
            Some(value) => std::env::set_var("ZCODE_DATA_BASE_DIR", value),
            None => std::env::remove_var("ZCODE_DATA_BASE_DIR"),
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Start a host on this test's runtime and connect a client to it.
async fn connected_client(label: &str) -> (Arc<RpcHost>, zcode_rpc_server::RpcClient) {
    let host = Arc::new(RpcHost::new());
    let endpoint = host
        .start_with(tokio::runtime::Handle::current())
        .expect("bind");
    assert!(
        endpoint.ws_url.starts_with("ws://127.0.0.1:"),
        "loopback only, got {}",
        endpoint.ws_url
    );
    let client = zcode_rpc_server::RpcClient::connect(&endpoint.ws_url, label)
        .await
        .expect("handshake");
    (host, client)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_structured_argument_survives_the_wire() {
    let (_host, client) = connected_client("probe").await;

    // The argument the UI sends: one TCP target, unreachable on purpose so the
    // probe resolves quickly.
    let response = client
        .call(
            "system",
            "probeIntranet",
            Some(&json!({
                "targets": [{ "host": "127.0.0.1", "port": 1 }],
                "attempts": 1,
            })),
        )
        .await
        .expect("probe answered");
    // The handler echoes each target back per result, so finding the port we
    // sent is proof the structured argument survived serialisation, framing, and
    // parsing rather than arriving as an empty object.
    assert_eq!(
        response["totalTargets"],
        json!(1),
        "the target list reached the handler intact: {response}"
    );
    assert_eq!(response["results"][0]["port"], json!(1), "{response}");
    assert_eq!(
        response["results"][0]["host"],
        json!("127.0.0.1"),
        "{response}"
    );
    // The failure reason is preserved too, which is a second thing a dropped
    // argument would destroy.
    assert!(
        response["results"][0]["error"].is_string(),
        "the probe's own error must survive: {response}"
    );
    assert_eq!(
        response["results"][0]["reachable"],
        json!(false),
        "port 1 on loopback must be unreachable: {response}"
    );

    // An unknown channel must fail with a clear, attributable error rather than
    // hang or be answered by some fallback.
    let error = client
        .call("not-a-ported-channel", "load", Some(&JsonValue::Null))
        .await
        .expect_err("an unported channel must not succeed");
    let text = error.to_string();
    assert!(
        text.contains("not-a-ported-channel"),
        "the failure must name the channel that is missing, got: {text}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_credential_save_takes_its_value_from_the_second_argument() {
    let home = IsolatedHome::new("save");
    let (_host, client) = connected_client("credential-save").await;

    // The wire shape the UI sends: `save(key, value)` as a positional array.
    // Reading `args[0]` for the value would store the key instead.
    client
        .call(
            "credential",
            "save",
            Some(&json!(["api-token", "the-real-secret"])),
        )
        .await
        .expect("save answered");

    let loaded = client
        .call("credential", "load", Some(&json!(["api-token"])))
        .await
        .expect("load answered");
    assert_eq!(
        loaded,
        json!("the-real-secret"),
        "the value must come from the second argument, not the key"
    );
    assert_ne!(loaded, json!("api-token"), "the key must not be the value");

    // And what landed on disk is the documented shape.
    let parsed: JsonValue =
        serde_json::from_str(&std::fs::read_to_string(home.store_path()).expect("store written"))
            .expect("valid json");
    let stored = parsed["api-token"].as_str().expect("stored value");
    assert!(stored.starts_with("enc:v1:"), "got {stored}");
    assert!(
        !stored.contains("the-real-secret"),
        "the secret must be encrypted"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_decrypt_failure_arrives_with_its_code_intact() {
    let home = IsolatedHome::new("code");
    // Written under one secret...
    std::env::set_var("ZCODE_CREDENTIAL_SECRET", "written-with-this");
    let (_writer, client) = connected_client("credential-write").await;
    client
        .call("credential", "save", Some(&json!(["k", "v"])))
        .await
        .expect("save answered");
    drop(client);
    assert!(home.store_path().exists(), "the writer must have persisted");

    // ...and read under another, so a second host derives a different key.
    std::env::set_var("ZCODE_CREDENTIAL_SECRET", "read-with-that");
    let (_reader, client) = connected_client("credential-read").await;

    let error = client
        .call("credential", "load", Some(&json!(["k"])))
        .await
        .expect_err("a different key must not decrypt");
    // `ClientError` keeps the upstream `code` rather than flattening the failure
    // to text, because the UI branches on it.
    let zcode_rpc_server::ClientError::RemoteCoded { message, code } = &error else {
        panic!("the upstream code must survive the wire, got {error:?}");
    };
    assert_eq!(
        code,
        &json!("ZCODE_CREDENTIAL_DECRYPT_FAILED"),
        "the code must survive the wire"
    );
    assert!(
        message.starts_with("Failed to decrypt credential: "),
        "the message prefix is the fallback signal: {message}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_credential_answers_null_rather_than_failing() {
    let _home = IsolatedHome::new("missing");
    let (_host, client) = connected_client("credential-missing").await;

    // A key nobody saved: a miss, which is null and not an error. Getting this
    // wrong in the other direction would make a signed-out user look like a
    // broken host.
    let missing = client
        .call("credential", "load", Some(&json!(["never-saved"])))
        .await
        .expect("a missing key must answer, not fail");
    assert_eq!(missing, JsonValue::Null);

    // A blank key violates the schema and is refused.
    let error = client
        .call("credential", "load", Some(&json!(["   "])))
        .await
        .expect_err("a blank key must be refused");
    assert!(error.to_string().contains("non-empty"), "got: {error}");
}
