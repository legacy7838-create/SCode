//! RPC host commands exposed to the renderer.
//!
//! The UI needs to know where the in-process RPC listener is bound. Electron had
//! no equivalent: the service port was transferred over a `MessagePort` during
//! startup, so the renderer never learned an address. Under Tauri the listener
//! is a real socket, so the address is real state that has to be published.



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
        // Eight native channels (`system`, `setting`, `credential`,
        // `client-scenes`, `client-config`, `onboarding-record`,
        // `provider-settings`, `model-selection`); the proxy is off, so nothing
        // is relayed to the Node process.
        // Every always-registered channel is present. The count may exceed this
        // because `zcode-agent` registers conditionally (only when the zcode-cli
        // entrypoint resolves), so this is a floor, not an exact pin.
        assert!(
            endpoint.channel_count >= 16,
            "at least the always-registered channels must be present, got {}",
            endpoint.channel_count
        );
        assert!(!host.proxy_enabled());
    }
}