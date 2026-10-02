//! `onboarding-record` channel — placeholder registered by the orchestrator so
//! the crate compiles while the port lands; the implementing agent replaces
//! this file wholesale. Transcribed target:
//! `packages/services/src/onboarding/onboardingRecordService.ts`.

use serde_json::Value as JsonValue;
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

pub struct OnboardingRecordService;

impl OnboardingRecordService {
    pub fn new() -> Self {
        Self
    }
}

impl Default for OnboardingRecordService {
    fn default() -> Self {
        Self::new()
    }
}

impl ChannelHandler for OnboardingRecordService {
    fn call(&self, _ctx: &str, method: &str, _args: &[JsonValue]) -> Result<JsonValue, HandlerError> {
        Err(HandlerError::message(format!(
            "onboarding-record.{method} is not implemented by the Rust host"
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
