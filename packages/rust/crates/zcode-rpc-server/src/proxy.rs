//! The proxy fallback: forwards channels that have no Rust implementation to the
//! still-running Node server.
//!
//! This is what makes the migration incremental instead of all-or-nothing. A
//! channel becomes native by registering a local handler; everything else is
//! relayed here, so the UI's single service connection keeps working while
//! channels are moved one at a time.
//!
//! # Ordering
//!
//! A local handler always wins. The proxy is only consulted for a channel the
//! registry does not have, so registering a channel is the complete and only step
//! needed to take ownership of it — there is no separate "unregister from the
//! proxy" call to forget.
//!
//! # Failure behaviour
//!
//! If the upstream connection is not up yet, the call is answered with a normal
//! RPC error rather than being deferred. Deferring would wait for a channel that
//! will never be registered locally, and would turn a recoverable startup race
//! into a one-second hang on every call.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::Value as JsonValue;

use crate::channel::{ChannelFallback, FallbackSubscription, HandlerError};
use crate::client::{ClientError, RpcClient};

/// Forwards to an upstream `@zcode/server`.
pub struct ProxyFallback {
    client: Arc<RpcClient>,
}

impl ProxyFallback {
    pub fn new(client: Arc<RpcClient>) -> Self {
        Self { client }
    }

    /// The underlying client, for callers that need to call through directly.
    pub fn client(&self) -> &Arc<RpcClient> {
        &self.client
    }
}

/// Turn a client-side failure into the error shape the UI already understands.
///
/// The UI reconstructs an `Error` from `PromiseError` and copies the passthrough
/// keys, so the failure stays legible instead of arriving as a bare transport
/// string the user cannot act on.
fn to_handler_error(error: ClientError) -> HandlerError {
    match error {
        // A relayed failure keeps the upstream's own code. Overwriting it with
        // a proxy code would be lossy in the one direction that matters: the UI
        // checks for a specific code, and `isCredentialDecryptError` gives up as
        // soon as it sees a different one, so a re-labelled decrypt failure
        // becomes indistinguishable from a transient fault.
        ClientError::RemoteCoded { message, code } => HandlerError::with_code(message, code),
        // No code came back, so name the relay itself.
        ClientError::Remote(message) => HandlerError::with_code(
            message,
            JsonValue::String("ZCODE_PROXY_UPSTREAM".to_owned()),
        ),
        ClientError::Timeout(ms) => HandlerError::with_code(
            format!("the service did not respond within {ms}ms"),
            JsonValue::String("ZCODE_PROXY_TIMEOUT".to_owned()),
        ),
        ClientError::Closed | ClientError::NoInitialize => HandlerError::with_code(
            "the service connection is not available",
            JsonValue::String("ZCODE_PROXY_UNAVAILABLE".to_owned()),
        ),
        other => HandlerError::with_code(
            other.to_string(),
            JsonValue::String("ZCODE_PROXY_ERROR".to_owned()),
        ),
    }
}

impl ChannelFallback for ProxyFallback {
    fn call(
        &self,
        _ctx: &str,
        channel: &str,
        method: &str,
        args: Vec<JsonValue>,
    ) -> BoxFuture<'static, Result<JsonValue, HandlerError>> {
        let client = Arc::clone(&self.client);
        let channel = channel.to_owned();
        let method = method.to_owned();
        Box::pin(async move {
            // The upstream server is the same TypeScript implementation, so the
            // positional list must be re-wrapped as the array it expects —
            // `fromService` spreads it with `Function.apply`.
            let payload = JsonValue::Array(args);
            client
                .call(&channel, &method, Some(&payload))
                .await
                .map_err(to_handler_error)
        })
    }

    fn subscribe(
        &self,
        _ctx: &str,
        channel: &str,
        event: &str,
        arg: Option<JsonValue>,
    ) -> BoxFuture<'static, Result<FallbackSubscription, HandlerError>> {
        let client = Arc::clone(&self.client);
        let channel = channel.to_owned();
        let event = event.to_owned();
        Box::pin(async move {
            let subscription = client
                .subscribe(&channel, &event, arg.as_ref())
                .await
                .map_err(to_handler_error)?;
            let upstream_id = subscription.upstream_id;
            Ok(FallbackSubscription {
                events: subscription.events,
                unsubscribe: Box::new(move || client.unsubscribe(upstream_id)),
            })
        })
    }
}
