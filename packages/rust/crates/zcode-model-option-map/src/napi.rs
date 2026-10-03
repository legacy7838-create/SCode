//! The `#[napi]` binding layer: `@zcode/rust/model-option-map`'s binary face.
//!
//! Spec: `docs/specs/rust-native-model-option-map.md`. The compile/evaluate/
//! merge-patch engine is `crate::*`; this module is JSON plumbing and error
//! re-raising only:
//!
//! - **Strings cross for documents, values for option values.** `apply` takes
//!   and returns the request body as one JSON string, so the adapter can skip
//!   its own `JSON.parse`/`JSON.stringify` pair — the shape invariant 10
//!   measured as the winning binding.
//! - **Error messages are the contract.** `RestrictedCelError`'s Display
//!   (`{message} at offset {offset}`) is byte-identical to the TS error's
//!   `.message`, so every catch site that surfaced a zod superRefine message
//!   or a program error sees the same string from the same validation.
//! - **Everything is synchronous**: a tiny-expression compile/evaluate cannot
//!   exceed a millisecond on any realistic input (invariant 4's short-
//!   primitive exemption).

use std::str::FromStr;

use napi::bindgen_prelude::Result;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::compiler::ModelOptionMapProgram as CoreProgram;
use crate::merge_patch::NamedJsonMergePatch;
use crate::option_maps::{
    compile_model_option_maps as compile_maps_core, CompiledModelOptionMaps as CoreMaps,
};
use crate::types::{ModelOptionName, ModelOptionMapError};

/// Re-raises a port error with its TS-identical message.
fn raised<E: std::fmt::Display>(error: E) -> napi::Error {
    napi::Error::new(napi::Status::GenericFailure, error.to_string())
}

fn parse_object(document: &str, what: &str) -> Result<Map<String, Value>> {
    serde_json::from_str::<Map<String, Value>>(document)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, format!("{what}: {error}")))
}

/// One compiled model-option map. Mirrors the TS `ModelOptionMapProgram`:
/// compile once (per model), evaluate per round.
#[napi]
pub struct ModelOptionMapProgram {
    inner: CoreProgram,
}

#[napi]
impl ModelOptionMapProgram {
    /// The trimmed source the program was compiled from.
    #[napi(getter)]
    pub fn source(&self) -> String {
        self.inner.source.clone()
    }

    /// Evaluates the map for one option value and answers the JSON-object
    /// patch. A non-object result or a CEL error is thrown with the TS message.
    #[napi]
    pub fn evaluate(&self, input: Value) -> Result<Value> {
        let input = normalize_js_number(input);
        let object = self.inner.evaluate(&input).map_err(raised)?;
        Ok(Value::Object(object))
    }
}

/// `compileModelOptionMap(source, variable)` — `variable` is
/// `"reasoningLevel"` or `"maxOutputTokens"`.
#[napi]
pub fn compile_model_option_map(source: String, variable: String) -> Result<ModelOptionMapProgram> {
    let variable_name =
        ModelOptionName::from_str(&variable).map_err(raised)?;
    let inner = crate::compiler::compile_model_option_map(&source, variable_name).map_err(raised)?;
    Ok(ModelOptionMapProgram { inner })
}

// ---------------------------------------------------------------------------
// compileModelOptionMaps
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpecsJson {
    reasoning_level: OptionMapSpecJson,
    max_output_tokens: OptionMapSpecJson,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OptionMapSpecJson {
    map: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValuesJson {
    reasoning_level: Option<String>,
    max_output_tokens: Value,
}

/// Restores the JS number spelling on the way in.
///
/// napi converts a JS number to `serde_json::Number` with a u32/i32 fast path
/// and falls back to f64 outside it, and serde's f64 formatter prints a
/// fraction (`5000000000.0`). JS prints `5000000000`. Integer-valued doubles
/// inside the safe range — exactly what survives the evaluator's json-safe
/// rule — are therefore re-wrapped as integers before they reach the engine.
/// Values that arrived as JSON *text* are already in JS spelling (JSON.stringify
/// never writes `.0` for an integer) and pass through unchanged.
fn normalize_js_number(value: Value) -> Value {
    match value {
        Value::Number(number) => {
            if let Some(as_f64) = number.as_f64() {
                if as_f64.is_finite()
                    && as_f64.fract() == 0.0
                    && as_f64.abs() <= 9_007_199_254_740_992.0
                    && number.as_i64().is_none()
                {
                    return Value::Number(serde_json::Number::from(as_f64 as i64));
                }
            }
            Value::Number(number)
        }
        Value::Array(values) => Value::Array(values.into_iter().map(normalize_js_number).collect()),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, normalize_js_number(value)))
                .collect(),
        ),
        other => other,
    }
}

/// The compiled pair (`reasoningLevel`, `maxOutputTokens`) applied to request
/// bodies. Compiled once when the Model is created; each request binds the
/// option values frozen for that round.
#[napi]
pub struct CompiledModelOptionMaps {
    inner: CoreMaps,
}

#[napi]
impl CompiledModelOptionMaps {
    /// `apply(bodyJson, valuesJson)` — one JSON string in, one out. This is
    /// the measured fast path (spec §3.3): the adapter already holds the body
    /// as a string, so no JS-side parse or re-stringify is needed.
    #[napi]
    pub fn apply(&self, body_json: String, values_json: String) -> Result<String> {
        let body = parse_object(&body_json, "model option map body must be a JSON object")?;
        let values: ValuesJson = serde_json::from_str(&values_json)
            .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error.to_string()))?;
        let max_output_tokens = normalize_js_number(values.max_output_tokens);
        // TS checked this before evaluating: an absent effective level is a
        // named error, not a serde field error.
        let reasoning_level = values.reasoning_level.ok_or_else(|| {
            napi::Error::new(
                napi::Status::GenericFailure,
                ModelOptionMapError {
                    message: "reasoningLevel requires an effective value".into(),
                }
                .to_string(),
            )
        })?;
        let patched = self
            .inner
            .apply(
                &body,
                &crate::option_maps::ModelOptionValues {
                    reasoning_level: &reasoning_level,
                    max_output_tokens,
                },
            )
            .map_err(raised)?;
        serde_json::to_string(&Value::Object(patched))
            .map_err(|error| napi::Error::new(napi::Status::GenericFailure, error.to_string()))
    }
}

/// `compileModelOptionMaps(specs)` where `specs` is
/// `{ reasoningLevel: { map }, maxOutputTokens: { map } }`.
#[napi]
pub fn compile_model_option_maps(specs_json: String) -> Result<CompiledModelOptionMaps> {
    let specs: SpecsJson = serde_json::from_str(&specs_json)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error.to_string()))?;
    let inner = compile_maps_core(&crate::option_maps::ModelOptionMapSpecs {
        reasoning_level_map: &specs.reasoning_level.map,
        max_output_tokens_map: &specs.max_output_tokens.map,
    })
    .map_err(raised)?;
    Ok(CompiledModelOptionMaps { inner })
}

// ---------------------------------------------------------------------------
// applyOrderedJsonMergePatches
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct NamedPatchJson {
    option: String,
    patch: Map<String, Value>,
}

/// `applyOrderedJsonMergePatches(bodyJson, patchesJson)`: ordered application
/// with conflict detection — two maps may not write overlapping JSON paths;
/// a `null` patch value deletes the key.
#[napi]
pub fn apply_ordered_json_merge_patches(
    body_json: String,
    patches_json: String,
) -> Result<String> {
    let body = parse_object(&body_json, "merge patch body must be a JSON object")?;
    let patches: Vec<NamedPatchJson> = serde_json::from_str(&patches_json)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error.to_string()))?;
    let patches = patches
        .into_iter()
        .map(|patch| NamedJsonMergePatch {
            option: patch.option,
            patch: patch.patch,
        })
        .collect::<Vec<_>>();
    let patched = crate::merge_patch::apply_ordered_json_merge_patches(&body, &patches)
        .map_err(raised)?;
    serde_json::to_string(&Value::Object(patched))
        .map_err(|error| napi::Error::new(napi::Status::GenericFailure, error.to_string()))
}
