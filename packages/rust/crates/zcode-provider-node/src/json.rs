//! Shared JSON shapes across the napi boundary.
//!
//! Every structured value crosses as a JSON string (the `zcode-task-index`
//! precedent): napi converts between `serde_json::Value` and JS objects on every
//! call, and the ported code has to see exactly the bytes the deleted TS codec
//! saw. Keeping that conversion in one module means the wire shape has a single
//! definition and the parity tests have a single subject.
//!
//! # Why the file form crosses, not the domain form
//!
//! The TS `ProviderConfigLayerSnapshot` carries `ProviderConfigMap` /
//! `ModelConfigRules` — domain objects with methods. The wrapper rehydrates
//! them with `@zcode/provider`'s existing parse functions, which take the
//! **file-form rule JSON**. So the boundary carries that file form
//! (`providerConfigRules` / `modelConfigRules`), and the rehydration runs the
//! identical parsers on the identical bytes the TS codec produced.

use serde_json::Value as JsonValue;

use zcode_provider_config::schema::{
    decode_builtin_release, decode_provider_config_file, encode_builtin_release,
    encode_provider_config_file, BuiltinRelease, PersonalConfigLayer,
};

fn to_json(value: &impl serde::Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
}

fn parse_json(input: &str) -> Result<JsonValue, String> {
    serde_json::from_str(input).map_err(|error| format!("invalid JSON at the boundary: {error}"))
}

// ---------------------------------------------------------------------------
// Personal layer snapshot
// ---------------------------------------------------------------------------

/// The personal snapshot as the wrapper rehydrates it: `revision` plus the
/// file-form rule JSON, plus `providerOrder` / `defaultModelSelection`.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerSnapshotJson {
    pub revision: String,
    /// `config.providerConfigRules` as stored.
    pub provider_config_rules: JsonValue,
    /// `config.modelConfigRules` as stored.
    pub model_config_rules: JsonValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_order: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model_selection: Option<JsonValue>,
}

pub fn snapshot_to_json(
    snapshot: &zcode_provider_config::repository::LayerSnapshot,
) -> Result<String, String> {
    to_json(&LayerSnapshotJson {
        revision: snapshot.revision.clone(),
        provider_config_rules: serde_json::to_value(&snapshot.providers)
            .map_err(|error| error.to_string())?,
        model_config_rules: serde_json::to_value(&snapshot.models)
            .map_err(|error| error.to_string())?,
        provider_order: snapshot.provider_order.clone(),
        default_model_selection: snapshot
            .default_model_selection
            .as_ref()
            .map(|selection| serde_json::to_value(selection))
            .transpose()
            .map_err(|error| error.to_string())?,
    })
}

/// What `update`'s transform receives and answers. The transform runs inside
/// the file lock, so it sees the locked current content and its answer is
/// validated before anything reaches the disk.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerUpdateJson {
    pub provider_config_rules: JsonValue,
    pub model_config_rules: JsonValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_order: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model_selection: Option<JsonValue>,
}

/// A layer update decoded through the same strict file shape `update` used to
/// decode. The transform's answer is written by re-encoding through this, so an
/// answer that does not round-trip is refused rather than silently normalised.
pub fn update_to_layer(update: &LayerUpdateJson) -> Result<PersonalConfigLayer, String> {
    // `providerOrder` and `defaultModelSelection` are optional in the file; the
    // strict decoder distinguishes absent from empty, so only what the caller
    // sent is written into the decode input.
    let mut config = serde_json::Map::new();
    if let Some(order) = &update.provider_order {
        config.insert(
            "providerOrder".to_string(),
            serde_json::to_value(order).map_err(|error| error.to_string())?,
        );
    }
    config.insert(
        "providerConfigRules".to_string(),
        update.provider_config_rules.clone(),
    );
    config.insert(
        "modelConfigRules".to_string(),
        update.model_config_rules.clone(),
    );
    if let Some(selection) = &update.default_model_selection {
        config.insert(
            "defaultModelSelection".to_string(),
            selection.clone(),
        );
    }
    let file = serde_json::json!({
        "schemaVersion": 1,
        "config": serde_json::Value::Object(config),
    });
    decode_provider_config_file(&file).map_err(|error| error.to_string())
}

/// Re-encode a layer through the strict decode → encode round-trip, so a
/// stored snapshot is always the canonical form (the TS `#writeLocked` did).
pub fn layer_to_persisted(layer: &PersonalConfigLayer) -> Result<PersonalConfigLayer, String> {
    let canonical = update_to_layer(&layer_to_update(layer)?)?;
    let encoded = encode_provider_config_file(&canonical);
    decode_provider_config_file(&serde_json::to_value(&encoded).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

pub fn layer_to_update(layer: &PersonalConfigLayer) -> Result<LayerUpdateJson, String> {
    Ok(LayerUpdateJson {
        provider_config_rules: serde_json::to_value(&layer.providers)
            .map_err(|error| error.to_string())?,
        model_config_rules: serde_json::to_value(&layer.models)
            .map_err(|error| error.to_string())?,
        provider_order: layer.provider_order.clone(),
        default_model_selection: layer
            .default_model_selection
            .as_ref()
            .map(|selection| serde_json::to_value(selection))
            .transpose()
            .map_err(|error| error.to_string())?,
    })
}

pub fn decode_layer_json(input: &str) -> Result<PersonalConfigLayer, String> {
    decode_provider_config_file(&parse_json(input)?).map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Builtin release
// ---------------------------------------------------------------------------

/// A builtin snapshot as the wrapper rehydrates it. The release envelope is
/// carried whole: the wrapper decodes it with `parseZCodeBuiltinProviderConfigRules`
/// / `parseZCodeBuiltinModelConfigRules`, exactly like the deleted
/// `decodeZCodeBuiltinRelease`.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinSnapshotJson {
    pub revision: String,
    /// The full release envelope: `{ schemaVersion, revision, config }`.
    pub release: JsonValue,
}

pub fn builtin_snapshot_to_json(
    revision: String,
    release: &BuiltinRelease,
) -> Result<String, String> {
    to_json(&BuiltinSnapshotJson {
        revision,
        release: serde_json::to_value(release_envelope(release)?)
            .map_err(|error| error.to_string())?,
    })
}

/// The release as its stored envelope — the exact bytes `encode_builtin_release`
/// produces, so the wrapper parses the same document the file holds.
pub fn release_envelope(release: &BuiltinRelease) -> Result<JsonValue, String> {
    let bytes = encode_builtin_release(release).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

pub fn decode_release_json(input: &str) -> Result<BuiltinRelease, String> {
    decode_builtin_release(&parse_json(input)?).map_err(|error| error.to_string())
}

pub fn release_to_json(release: &BuiltinRelease) -> Result<String, String> {
    to_json(&release_envelope(release)?)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_update_round_trips_through_the_strict_file_shape() {
        let json = r#"{
            "providerConfigRules": {"providerRules": []},
            "modelConfigRules": {"providerModelRules": [], "manualProviderModelRules": []},
            "providerOrder": ["b", "a"]
        }"#;
        let update: LayerUpdateJson = serde_json::from_str(json).expect("parse");
        let layer = update_to_layer(&update).expect("decode");
        assert_eq!(layer.provider_order, Some(vec!["b".to_string(), "a".to_string()]));
        let back = layer_to_persisted(&layer).expect("canonicalise");
        assert_eq!(back.provider_order, layer.provider_order);
    }

    #[test]
    fn a_bad_answer_is_refused_instead_of_normalised() {
        let json = r#"{
            "providerConfigRules": {"providerRules": [{"providerId": ""}]},
            "modelConfigRules": {"providerModelRules": [], "manualProviderModelRules": []}
        }"#;
        let update: LayerUpdateJson = serde_json::from_str(json).expect("parse");
        assert!(update_to_layer(&update).is_err(), "an empty providerId is refused");
    }

    #[test]
    fn the_builtin_snapshot_carries_the_whole_envelope() {
        let release =
            decode_release_json(include_str!("../../zcode-provider-config/tests/_fixture_canonical_builtin.json"))
                .expect("release");
        let json = builtin_snapshot_to_json("zcode-builtin:32:key".into(), &release).expect("json");
        let parsed: BuiltinSnapshotJson = serde_json::from_str(&json).expect("reparse");
        assert_eq!(parsed.revision, "zcode-builtin:32:key");
        assert_eq!(parsed.release["revision"], serde_json::json!(32));
        assert!(parsed.release["config"]["providerConfigRules"]["templateRules"]
            .as_array()
            .is_some_and(|rules| !rules.is_empty()));
    }
}
