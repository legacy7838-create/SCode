//! RPC host commands exposed to the renderer.
//!
//! The UI needs to know where the in-process RPC listener is bound. Electron had
//! no equivalent: the service port was transferred over a `MessagePort` during
//! startup, so the renderer never learned an address. Under Tauri the listener
//! is a real socket, so the address is real state that has to be published.

use tauri::State;

use crate::rpc::RpcHost;

/// Result of asking the host where its RPC listener is.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcEndpointState {
    /// `true` when the listener is bound and accepting.
    pub running: bool,
    /// The `ws://` URL the UI should connect to; `null` when not running.
    pub ws_url: Option<String>,
    /// The bound `host:port`; `null` when not running.
    pub address: Option<String>,
    /// Channels served natively so far. Zero until channels are ported.
    pub channel_count: usize,
    /// `true` when unported channels are relayed to `@zcode/server`.
    pub proxy_enabled: bool,
}

/// Where the in-process RPC listener is, and whether it is up.
///
/// Returns `running: false` rather than an error when the listener failed to
/// start: the UI is still served by `@zcode/server` at this stage, so a missing
/// RPC listener is a degraded capability, not a fatal condition.
#[tauri::command]
pub fn get_rpc_endpoint(host: State<'_, RpcHost>) -> RpcEndpointState {
    match host.endpoint() {
        Some(endpoint) => RpcEndpointState {
            running: true,
            ws_url: Some(endpoint.ws_url),
            address: Some(endpoint.address),
            // Read the live count rather than the value captured at bind time,
            // so a channel registered after startup is reflected.
            channel_count: host.channel_count(),
            proxy_enabled: host.proxy_enabled(),
        },
        None => RpcEndpointState {
            running: false,
            ws_url: None,
            address: None,
            channel_count: 0,
            proxy_enabled: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use crate::rpc::RpcHost;

    #[test]
    fn reports_not_running_before_start() {
        let host = RpcHost::new();
        assert!(
            host.endpoint().is_none(),
            "a host that has not started must not publish an endpoint"
        );
    }

    #[test]
    fn reports_running_once_bound() {
        let host = RpcHost::new();
        host.start().expect("bind");
        let endpoint = host.endpoint().expect("endpoint");
        assert!(endpoint.ws_url.starts_with("ws://127.0.0.1:"));
        // Three native channels (`system`, `setting`, `credential`); the proxy is
        // off, so nothing is relayed to the Node process.
        assert_eq!(endpoint.channel_count, 3);
        assert!(!host.proxy_enabled());
    }
}
