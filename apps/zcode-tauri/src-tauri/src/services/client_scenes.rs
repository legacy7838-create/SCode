//! `client-scenes` channel — placeholder registered by the orchestrator so the
//! crate compiles while the port lands; the implementing agent replaces this
//! file wholesale. Transcribed target: `packages/services/src/client-scenes/`.

use serde_json::Value as JsonValue;
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

pub struct ClientScenesService;

impl ClientScenesService {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ClientScenesService {
    fn default() -> Self {
        Self::new()
    }
}

impl ChannelHandler for ClientScenesService {
    fn call(&self, _ctx: &str, method: &str, _args: &[JsonValue]) -> Result<JsonValue, HandlerError> {
        Err(HandlerError::message(format!(
            "client-scenes.{method} is not implemented by the Rust host"
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
