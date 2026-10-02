//! `model-selection` channel — the model picker's candidate view.
//!
//! Replaces the `@zcode/server` `model-selection` channel. Read-only: it serves
//! the registry view projected as selection candidates plus the resolved
//! effective selection. The same `ProviderRegistryService` backs it, so a
//! settings write is reflected in the next selection view.

use serde_json::Value as JsonValue;
use zcode_provider_config::facades::create_model_selection_view;
use zcode_provider_config::registry_service::ProviderRegistryService;
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

use crate::services::provider_settings::build_provider_registry;

pub struct ModelSelectionService {
    registry: ProviderRegistryService,
}

impl ModelSelectionService {
    pub fn new() -> Result<Self, String> {
        Ok(Self { registry: build_provider_registry()? })
    }
}

impl Default for ModelSelectionService {
    fn default() -> Self {
        Self::new().expect("provider runtime must build at construction")
    }
}

impl ChannelHandler for ModelSelectionService {
    fn call(&self, _ctx: &str, method: &str, args: &[JsonValue]) -> Result<JsonValue, HandlerError> {
        if self.registry.get_snapshot().is_none() {
            self.registry.start().map_err(handler_error)?;
        }
        match method {
            "getView" => {
                let input = args.first().cloned().unwrap_or(JsonValue::Null);
                let configured_default = input
                    .get("configuredDefault")
                    .filter(|v| !v.is_null())
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(handler_error)?;
                let selection = input
                    .get("selection")
                    .filter(|v| !v.is_null())
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(handler_error)?;
                let snapshot = self
                    .registry
                    .get_snapshot()
                    .ok_or_else(|| handler_error("ProviderRegistryService has not started() yet"))?;
                let view = create_model_selection_view(zcode_provider_config::facades::ModelSelectionViewInput {
                    revision: snapshot.registry.revision,
                    registry: &snapshot.registry,
                    configured_default: configured_default.as_ref(),
                    input_selection: selection.as_ref(),
                    account_states: snapshot.account.states.as_deref(),
                    classify_provider: None,
                    resolve_legacy_reasoning_level: None,
                });
                serde_json::to_value(&view).map_err(handler_error)
            }
            other => Err(HandlerError::message(format!(
                "model-selection.{other} is not implemented by the Rust host"
            ))),
        }
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

fn handler_error(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::message(error.to_string())
}