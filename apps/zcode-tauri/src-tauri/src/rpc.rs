//! In-process RPC host — owns the `zcode-rpc-server` listener for this app.
//!
//! # Why this exists
//!
//! The UI's `IServiceAccessor` (the channel RPC channel carrying files, git,
//! settings, agent, tasks) is currently served by `@zcode/server`, a separate
//! Node process. `zcode-rpc-server` implements the same protocol natively, so
//! this module is the seam where the app starts that listener and publishes
//! where the UI can reach it.
//!
//! # State of the migration
//!
//! The listener is up and reachable, but **no service channels are registered
//! yet**, so a request to any channel is deferred and then answered with
//! `PromiseError: Unknown channel` after the one-second deadline. That is
//! deliberate: the UI keeps using the Node server until the proxy fallback
//! (forwarding unported channels to Node) and the first native channels land.
//! Starting the listener early means the endpoint is settled, observable, and
//! covered by tests before anything depends on it.
//!
//! # Lifecycle
//!
//! Bind happens synchronously in `setup()` — before the event loop — so the
//! real port is known (and reported) before any client can connect. Serving is
//! then handed to Tauri's async runtime. A bind failure is reported and the app
//! continues without the listener: the Node path is still the serving path at
//! this stage, so a busy port must not stop the app from starting.

use std::sync::{Arc, Mutex};

use zcode_rpc_server::channel::{ChannelFallback, ChannelHandler, ChannelRegistry};
use zcode_rpc_server::{ProxyFallback, RpcServer};

/// Environment override for the listen address.
const ADDR_ENV: &str = "ZCODE_TAURI_RPC_ADDR";

/// Environment override for the upstream `@zcode/server` port to proxy to.
const UPSTREAM_PORT_ENV: &str = "ZCODE_TAURI_RPC_UPSTREAM_PORT";

/// Opt-in switch for relaying unported channels to `@zcode/server`.
///
/// Off by default: the ported channel set must be the only source of truth, so a
/// channel that has not been ported yet fails loudly here rather than being
/// answered by the Node process. Turning it on reintroduces the dual runtime,
/// which is only useful while migrating.
const PROXY_ENV: &str = "ZCODE_TAURI_RPC_PROXY";

/// The port `dev-tauri` starts `@zcode/server` on (see `scripts/dev-tauri.mjs`).
const DEFAULT_UPSTREAM_PORT: u16 = 3030;

/// Loopback only. The protocol has no authentication of its own — it is the
/// same trusted-host channel the desktop attaches to — so binding it to anything
/// but loopback would expose every service to the network.
const DEFAULT_ADDR: &str = "127.0.0.1:0";

/// The address the listener actually bound, plus what the UI needs to connect.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcEndpoint {
    /// Bound host:port, with any ephemeral port resolved.
    pub address: String,
    /// The URL the UI should open, e.g. `ws://127.0.0.1:41234`.
    pub ws_url: String,
    /// Channels currently served natively. Zero until channels are ported.
    pub channel_count: usize,
    /// `true` when unported channels are being relayed to `@zcode/server`.
    pub proxy_enabled: bool,
}

/// Managed state so the renderer can query the endpoint.
///
/// `Debug` is derived by hand rather than with `#[derive]` because the registry
/// holds boxed handlers that are not `Debug`, and Tauri requires managed state to
/// be `Send + Sync + 'static` only — the derive is for log output, so it reports
/// the endpoint and registry size instead of the handler contents.
impl std::fmt::Debug for RpcHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RpcHost")
            .field("endpoint", &self.endpoint())
            .field("channel_count", &self.registry.len())
            .field("proxied", &self.proxy_enabled())
            .finish()
    }
}

/// Managed state so the renderer can query the endpoint.
pub struct RpcHost {
    endpoint: Mutex<Option<RpcEndpoint>>,
    registry: Arc<ChannelRegistry>,
    proxied: Arc<Mutex<bool>>,
}

impl RpcHost {
    /// A fresh registry with the natively-ported channels already registered.
    ///
    /// Registration is the whole of a channel's migration: once a handler is
    /// registered here it is served by this host, and there is no separate
    /// unregister step to remember.
    ///
    /// Equivalent to `Self::default()`.
    pub fn new() -> Self {
        Self::default()
    }

    /// The same host `new` builds, spelled as a `Default` impl so the two
    /// cannot drift.
    fn build() -> Self {
        let registry = Arc::new(ChannelRegistry::new());
        registry.register_shared(
            "system",
            Arc::new(crate::services::SystemService::new()) as Arc<dyn ChannelHandler>,
        );
        registry.register_shared(
            "setting",
            Arc::new(crate::services::SettingService::new()) as Arc<dyn ChannelHandler>,
        );
        // Registering the credential channel depends on deriving its cipher key,
        // which depends on the OS username. A host that cannot determine one is
        // left without the channel rather than given one that decrypts every
        // stored login into garbage: an unregistered channel fails loudly at the
        // call site, whereas a wrong key fails as "signed out" with no cause.
        // Startup itself must not abort, so this is reported and skipped.
        // `onboarding-record` reads two stores that are already native: the
        // credential store for the signed-in userId, and the task index for the
        // `existing_local_task` decision. Both are built once here and shared
        // with their own channel below, so the process holds one credential
        // instance and one task-index connection rather than a second of each.
        //
        // `zcode-task` is registered at construction for the same reason the
        // credential channel is: if the index cannot open, the channel must be
        // absent (loud at the call site) rather than present and broken.
        let credential_service = match crate::services::CredentialService::new() {
            Ok(service) => {
                let shared = Arc::new(service);
                registry.register_shared("credential", shared.clone() as Arc<dyn ChannelHandler>);
                Some(shared)
            }
            Err(error) => {
                tracing::error!(
                    %error,
                    "credential channel not registered; the cipher key could not be derived"
                );
                None
            }
        };
        let task_index = match crate::services::ZCodeTaskService::new() {
            Ok(service) => {
                let shared = Arc::new(service);
                registry.register_shared("zcode-task", shared.clone() as Arc<dyn ChannelHandler>);
                Some(shared)
            }
            Err(error) => {
                tracing::error!(
                    %error,
                    "zcode-task channel not registered; the task index could not open"
                );
                None
            }
        };
        registry.register_shared(
            "client-scenes",
            Arc::new(crate::services::ClientScenesService::new()) as Arc<dyn ChannelHandler>,
        );
        registry.register_shared(
            "client-config",
            Arc::new(crate::services::ClientConfigService::new()) as Arc<dyn ChannelHandler>,
        );
        // Both dependencies must exist: an unregistered channel fails loudly at
        // the call site, which is what a placeholder that answered every method
        // with "not implemented" did not do.
        match (credential_service, task_index) {
            (Some(credentials), Some(task_index)) => {
                match crate::services::OnboardingRecordService::new(credentials, task_index) {
                    Ok(service) => registry.register_shared(
                        "onboarding-record",
                        Arc::new(service) as Arc<dyn ChannelHandler>,
                    ),
                    Err(error) => tracing::error!(
                        %error,
                        "onboarding-record channel not registered; the record store could not be built"
                    ),
                }
            }
            _ => tracing::error!(
                "onboarding-record channel not registered; it needs the credential store and the \
                 task index, neither of which could be opened"
            ),
        }
        // `provider-settings` / `model-selection` back the provider settings and
        // model picker. Construction reads no files (paths only); the first call
        // lazily reads the materialised built-in release and personal config. A
        // build failure leaves the channel unregistered — it fails loudly rather
        // than serving a stub — matching the credential channel's discipline.
        match crate::services::ProviderSettingsService::new() {
            Ok(service) => registry.register_shared(
                "provider-settings",
                Arc::new(service) as Arc<dyn ChannelHandler>,
            ),
            Err(error) => tracing::error!(
                %error,
                "provider-settings channel not registered; the provider runtime could not build"
            ),
        }
        match crate::services::ModelSelectionService::new() {
            Ok(service) => registry.register_shared(
                "model-selection",
                Arc::new(service) as Arc<dyn ChannelHandler>,
            ),
            Err(error) => tracing::error!(
                %error,
                "model-selection channel not registered; the provider runtime could not build"
            ),
        }
        registry.register_shared(
            "file",
            Arc::new(crate::services::FileService::new()) as Arc<dyn ChannelHandler>,
        );
        registry.register_shared(
            "file-watcher",
            Arc::new(crate::services::FileWatcherService::new()) as Arc<dyn ChannelHandler>,
        );
        registry.register_shared(
            "git",
            Arc::new(crate::services::GitService::new()) as Arc<dyn ChannelHandler>,
        );
        registry.register_shared(
            "git-checkpoint",
            Arc::new(crate::services::GitCheckpointService::new()) as Arc<dyn ChannelHandler>,
        );
        registry.register_shared(
            "media-preview",
            Arc::new(crate::services::MediaPreviewService::new()) as Arc<dyn ChannelHandler>,
        );
        // `zcode-agent` registers only when the zcode-cli entrypoint resolves;
        // otherwise it stays unregistered (fails loudly at the call site) rather
        // than registered as a broken stub with no agent command.
        if let Some(command) = crate::services::zcode_agent_channel::resolve_agent_command() {
            registry.register_shared(
                "zcode-agent",
                Arc::new(crate::services::ZCodeAgentService::new(command)) as Arc<dyn ChannelHandler>,
            );
        }
        registry.register_shared(
            "broadcast",
            Arc::new(crate::services::BroadcastService::new()) as Arc<dyn ChannelHandler>,
        );
        registry.register_shared(
            "prompt-attachment-transfer",
            Arc::new(crate::services::PromptAttachmentTransferService::new())
                as Arc<dyn ChannelHandler>,
        );
        match crate::services::OffPeakTaskService::new() {
            Ok(service) => registry.register_shared(
                "off-peak-task",
                Arc::new(service) as Arc<dyn ChannelHandler>,
            ),
            Err(error) => tracing::error!(
                %error,
                "off-peak-task channel not registered; the task index could not open"
            ),
        }
        Self {
            endpoint: Mutex::new(None),
            registry,
            proxied: Arc::new(Mutex::new(false)),
        }
    }
}

impl Default for RpcHost {
    fn default() -> Self {
        Self::build()
    }
}

impl RpcHost {
    /// The channel registry, so services can register against it.
    ///
    /// Registration after startup is supported on purpose: channels arrive as
    /// they are ported, and the UI may already be connected.
    pub fn registry(&self) -> Arc<ChannelRegistry> {
        Arc::clone(&self.registry)
    }

    /// The bound endpoint, or `None` when the listener failed to start.
    pub fn endpoint(&self) -> Option<RpcEndpoint> {
        self.endpoint.lock().expect("rpc endpoint poisoned").clone()
    }

    /// Whether unported channels are currently relayed upstream.
    pub fn proxy_enabled(&self) -> bool {
        *self.proxied.lock().expect("proxy state poisoned")
    }

    /// Bind the listener and start serving.
    ///
    /// Returns the endpoint on success. A failure is returned rather than
    /// panicked on: the app must still start on the Node path.
    ///
    /// The proxy is attached *after* the listener is bound, because the upstream
    /// client can only be opened asynchronously while `setup()` is synchronous.
    /// That ordering is safe: the slot is read per accepted connection, so a
    /// client arriving before the proxy is ready still gets served, it just has
    /// nothing to fall back on for that one request.
    pub fn start(&self) -> Result<RpcEndpoint, String> {
        // The app path: Tauri's runtime, which exists during `setup()`.
        self.start_with(tauri::async_runtime::handle().inner().clone())
    }

    /// Start on a caller-supplied runtime.
    ///
    /// Split out from [`RpcHost::start`] because Tauri's runtime only exists
    /// inside the app, and the wire behaviour of the host still has to be
    /// testable outside it.
    pub fn start_with(&self, runtime: tokio::runtime::Handle) -> Result<RpcEndpoint, String> {
        let addr = std::env::var(ADDR_ENV)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_ADDR.to_owned());

        let listener = RpcServer::new(Arc::clone(&self.registry))
            .bind_sync(&addr)
            .map_err(|error| error.to_string())?;
        let fallback_slot = listener.fallback_slot();

        let bound = listener
            .local_addr()
            .map(|address| address.to_string())
            .map_err(|error| format!("bound listener has no address: {error}"))?;

        // Reconstruct a ws:// URL from the bound socket address rather than the
        // configured string, so an ephemeral port is reported correctly.
        let ws_url = to_ws_url(&bound);

        // Hand the listener to Tauri's runtime. `serve()` never returns, so a
        // detached task is the correct shape here.
        runtime.spawn(listener.serve());

        // Open the upstream client and attach the proxy — only when explicitly
        // enabled. Off by default so nothing is answered by the Node process: a
        // channel that has not been ported fails with a clear error instead.
        if std::env::var(PROXY_ENV).ok().as_deref() != Some("1") {
            tracing::info!(
                channels = self.registry.len(),
                "in-process rpc serving natively; unported channels will not be proxied"
            );
            let endpoint = RpcEndpoint {
                address: bound,
                ws_url,
                channel_count: self.registry.len(),
                proxy_enabled: false,
            };
            *self.endpoint.lock().expect("rpc endpoint poisoned") = Some(endpoint.clone());
            return Ok(endpoint);
        }

        let upstream_port = std::env::var(UPSTREAM_PORT_ENV)
            .ok()
            .and_then(|value| value.trim().parse::<u16>().ok())
            .unwrap_or(DEFAULT_UPSTREAM_PORT);
        let registry_for_slot = Arc::clone(&self.registry);
        let proxied = Arc::clone(&self.proxied);
        // Tauri exposes its own runtime handle; the fallback drives its async
        // calls with a tokio handle, which is reachable through it. Tauri runs on
        // tokio, so this is the same runtime the listener is served on.
        // The spawned task needs its own handle to attach the fallback, while
        // `runtime.spawn` borrows the handle to do the spawning; a second clone
        // keeps both satisfied.
        let fallback_runtime = runtime.clone();
        runtime.spawn(async move {
            // `connect_local_server` builds the same loopback URL from the port;
            // it is named here only so the log line below can be explicit about
            // which endpoint was dialled.
            let upstream_url = zcode_rpc_server::client::ws_url("127.0.0.1", upstream_port, "/ws");
            match zcode_rpc_server::client::connect_local_server(upstream_port).await {
                Ok(client) => {
                    let fallback: Arc<dyn ChannelFallback> =
                        Arc::new(ProxyFallback::new(Arc::new(client)));
                    RpcServer::set_fallback(&fallback_slot, fallback, fallback_runtime);
                    *proxied.lock().expect("proxy state poisoned") = true;
                    tracing::info!(
                        %upstream_url,
                        upstream_port,
                        channels = registry_for_slot.len(),
                        "unported channels will be relayed to @zcode/server"
                    );
                }
                Err(error) => {
                    tracing::warn!(
                        %error,
                        upstream_port,
                        "no upstream service connection; unported channels are not relayed"
                    );
                }
            }
        });

        let endpoint = RpcEndpoint {
            address: bound,
            ws_url,
            channel_count: self.registry.len(),
            proxy_enabled: false,
        };

        *self.endpoint.lock().expect("rpc endpoint poisoned") = Some(endpoint.clone());
        Ok(endpoint)
    }

    /// Recompute the channel count after registrations.
    ///
    /// Called on a successful start and available for the status command so the
    /// UI can show migration progress without a second source of truth.
    pub fn channel_count(&self) -> usize {
        self.registry.len()
    }
}

/// Convert a bound `host:port` into a WebSocket URL.
///
/// IPv6 literals have to be bracketed or the URL is ambiguous
/// (`ws://::1:1234` does not parse), so they are handled explicitly.
fn to_ws_url(bound: &str) -> String {
    // IPv6 literals have to be bracketed or the URL is ambiguous
    // (`ws://::1:1234` does not parse), so they are handled explicitly.
    if let Some(port) = bound.strip_prefix('[') {
        // Already-bracketed IPv6, e.g. `[::1]:41234`.
        let _ = port;
        return format!("ws://{bound}");
    }
    if bound.matches(':').count() > 1 {
        // Bare IPv6 without brackets; split off the trailing port.
        if let Some((host, port)) = bound.rsplit_once(':') {
            return format!("ws://[{host}]:{port}");
        }
    }
    format!("ws://{bound}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_ws_url_for_ipv4_and_hostnames() {
        assert_eq!(to_ws_url("127.0.0.1:41234"), "ws://127.0.0.1:41234");
        assert_eq!(to_ws_url("localhost:9000"), "ws://localhost:9000");
    }

    #[test]
    fn brackets_bare_ipv6_so_the_url_parses() {
        assert_eq!(to_ws_url("::1:41234"), "ws://[::1]:41234");
    }

    #[test]
    fn leaves_an_already_bracketed_ipv6_alone() {
        assert_eq!(to_ws_url("[::1]:41234"), "ws://[::1]:41234");
    }

    /// Channels ported to Rust so far.
    ///
    /// Listing them explicitly means adding a channel surfaces here as a failing
    /// test rather than as a silent count change nobody notices.
    const PORTED_CHANNELS: [&str; 17] = [
        "system",
        "setting",
        "credential",
        "client-scenes",
        "client-config",
        "onboarding-record",
        "provider-settings",
        "model-selection",
        "file",
        "file-watcher",
        "git",
        "git-checkpoint",
        "media-preview",
        "zcode-task",
        "broadcast",
        "off-peak-task",
        "prompt-attachment-transfer",
    ];

    #[test]
    fn the_credential_channel_is_registered_whenever_the_key_is_derivable() {
        // `RpcHost::new` skips the credential channel when it cannot derive the
        // cipher key, which is a deliberate refusal to serve a channel that
        // would report every login as corrupt. It must therefore register
        // whenever derivation *does* work, or the port looks healthy while every
        // user is silently signed out.
        let host = RpcHost::new();
        let derivable = crate::services::CredentialService::new().is_ok();
        assert_eq!(
            host.registry().contains("credential"),
            derivable,
            "registration must track whether the key could be derived"
        );
    }

    #[test]
    fn the_onboarding_record_channel_serves_instead_of_refusing() {
        // The placeholder this replaces was counted in `PORTED_CHANNELS` while
        // answering every method with "not implemented". Registration alone is
        // therefore not evidence; a call that comes back `Ok` is. Only read-only
        // methods are called here — the write paths are covered in
        // `services::onboarding_record::tests`, against a temp file.
        let host = RpcHost::new();
        let handler = host
            .registry()
            .get("onboarding-record")
            .expect("the channel must be registered");
        for method in ["getRecords", "getLatestEntry"] {
            let value = handler.call("", method, &[]).unwrap_or_else(|error| {
                panic!("{method} must be served by the port, not refused: {error}")
            });
            assert!(
                value.is_null() || value.is_object(),
                "{method} must answer a record or no record, got {value}"
            );
        }
    }

    #[test]
    fn starts_on_loopback_serving_the_ported_channels() {
        let host = RpcHost::new();
        // Default addr is loopback with an ephemeral port, so this cannot collide.
        let endpoint = host.start().expect("listener should bind");
        assert!(
            endpoint.ws_url.starts_with("ws://127.0.0.1:"),
            "must be loopback only, got {}",
            endpoint.ws_url
        );
        // Every ported channel must be registered. The count may exceed the
        // list because a conditional channel (`zcode-agent`, which registers
        // only when the zcode-cli entrypoint resolves) can add one; the
        // per-channel `contains` check below is the real pin.
        assert!(
            endpoint.channel_count >= PORTED_CHANNELS.len(),
            "at least the ported channels must be registered, got {}",
            endpoint.channel_count
        );
        for channel in PORTED_CHANNELS {
            assert!(
                host.registry().contains(channel),
                "the ported channel `{channel}` must be registered"
            );
        }
        assert_eq!(host.endpoint().expect("endpoint recorded").ws_url, endpoint.ws_url);
    }

    #[test]
    fn the_node_proxy_is_off_by_default() {
        let host = RpcHost::new();
        host.start().expect("bind");
        // Nothing may be answered by the Node process unless explicitly enabled,
        // so a channel that is not ported fails instead of being relayed.
        assert!(
            !host.proxy_enabled(),
            "the JS fallback must be opt-in, never the default"
        );
        assert!(
            !host.registry().contains("conversation-share"),
            "no unported channel may be registered (conversation-share is the current example)"
        );
    }

    #[test]
    fn reports_the_bound_port_not_the_requested_one() {
        // Port 0 means "any free port", so the reported address must be a real
        // one; this is what makes the endpoint safe to hand to the UI.
        let host = RpcHost::new();
        let endpoint = host.start().expect("bind");
        let port: u16 = endpoint
            .address
            .rsplit(':')
            .next()
            .and_then(|p| p.parse().ok())
            .expect("address must end in a port");
        assert_ne!(port, 0, "an ephemeral bind must resolve to a real port");
    }

    #[test]
    fn a_bind_failure_is_reported_not_panicked() {
        // Occupy a port, then try to bind the same one.
        let first = RpcHost::new();
        let bound = first.start().expect("first bind");
        let addr = bound.address.clone();

        let second = RpcHost::new();
        std::env::set_var(ADDR_ENV, &addr);
        let result = second.start();
        std::env::remove_var(ADDR_ENV);

        // Re-binding an in-use port must fail cleanly. (On some platforms SO_REUSEADDR
        // semantics can let this succeed; if so the app simply reports no error, which
        // is still not a panic.)
        if let Err(message) = result {
            assert!(
                message.contains("failed to bind"),
                "unexpected failure shape: {message}"
            );
        }
        assert!(
            second.endpoint().is_none(),
            "a host that failed to bind must not publish an endpoint"
        );
    }
}
