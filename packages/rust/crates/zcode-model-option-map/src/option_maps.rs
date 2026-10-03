//! Compiled option maps applied to a request body.
//!
//! Port of `packages/model-option-map/src/option-maps.ts`.

use std::sync::Arc;

use crate::compiler::{compile_model_option_map, ModelOptionMapProgram};
use crate::merge_patch::{apply_ordered_json_merge_patches, NamedJsonMergePatch};
use crate::types::{ModelOptionMapError, ModelOptionName};
use crate::RestrictedCelError;

pub struct ModelOptionMapSpecs<'a> {
    pub reasoning_level_map: &'a str,
    pub max_output_tokens_map: &'a str,
}

pub struct ModelOptionValues<'a> {
    pub reasoning_level: &'a str,
    /// Carried as a JSON number, not an `f64`: `JSON.stringify(8192)` writes
    /// `8192`, and re-wrapping it as an f64 would emit `8192.0` — different
    /// request bytes for the same logical value.
    pub max_output_tokens: serde_json::Value,
}

pub struct CompiledModelOptionMaps {
    reasoning_level: Arc<ModelOptionMapProgram>,
    max_output_tokens: Arc<ModelOptionMapProgram>,
}

pub fn compile_model_option_maps(
    specs: &ModelOptionMapSpecs,
) -> Result<CompiledModelOptionMaps, RestrictedCelError> {
    Ok(CompiledModelOptionMaps {
        reasoning_level: compile_model_option_map(
            specs.reasoning_level_map,
            ModelOptionName::ReasoningLevel,
        )?,
        max_output_tokens: compile_model_option_map(
            specs.max_output_tokens_map,
            ModelOptionName::MaxOutputTokens,
        )?,
    })
}

impl CompiledModelOptionMaps {
    pub fn apply(
        &self,
        body: &serde_json::Map<String, serde_json::Value>,
        values: &ModelOptionValues,
    ) -> Result<serde_json::Map<String, serde_json::Value>, ModelOptionMapError> {
        let reasoning_level = values.reasoning_level;
        let max_output_tokens = &values.max_output_tokens;
        if !max_output_tokens.is_number() {
            return Err(ModelOptionMapError {
                message: "maxOutputTokens must be a finite number".into(),
            });
        }
        let patches = vec![
            NamedJsonMergePatch {
                option: "reasoningLevel".into(),
                patch: self
                    .reasoning_level
                    .evaluate(&serde_json::Value::String(reasoning_level.to_string()))
                    .map_err(|error| ModelOptionMapError {
                        message: error.to_string(),
                    })?,
            },
            NamedJsonMergePatch {
                option: "maxOutputTokens".into(),
                patch: self
                    .max_output_tokens
                    .evaluate(max_output_tokens)
                    .map_err(|error| ModelOptionMapError {
                        message: error.to_string(),
                    })?,
            },
        ];
        apply_ordered_json_merge_patches(body, &patches)
    }
}
