//! `client-config` channel — placeholder registered by the orchestrator so the
//! crate compiles while the port lands; the implementing agent replaces this
//! file wholesale. Transcribed target: `packages/services/src/client-config/`.

use serde_json::Value as JsonValue;
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

pub struct ClientConfigService;

impl ClientConfigService {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ClientConfigService {
    fn default() -> Self {
        Self::new()
    }
}

impl ChannelHandler for ClientConfigService {
    fn call(&self, _ctx: &str, method: &str, _args: &[JsonValue]) -> Result<JsonValue, HandlerError> {
        Err(HandlerError::message(format!(
            "client-config.{method} is not implemented by the Rust host"
        )))
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
