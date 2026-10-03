//! Pure-Rust port of `packages/model-option-map` — the restricted CEL
//! expression subset used to compile model option maps.
//!
//! No Node dependency: provider config validation (`packages/shared/src/
//! model-config.ts`) calls `compileModelOptionMap` at file-decode time, which
//! is the reason this crate exists. Acceptance and rejection behavior matches
//! the TypeScript tokenizer/parser/evaluator, including error messages.

pub mod compiler;

/// The Node binding layer — only present when the crate is built for Node.
/// Hosts that link the rlib (the Tauri host through `zcode-provider-config`)
/// build with `default-features = false` and never see the Node ABI.
#[cfg(feature = "napi")]
pub mod napi;
pub mod evaluator;
pub mod merge_patch;
pub mod option_maps;
pub mod parser;
pub mod tokenizer;
pub mod types;

pub use compiler::{
    compile_model_option_map, compile_restricted_cel, ModelOptionMapProgram, RestrictedCelProgram,
};
pub use option_maps::{
    compile_model_option_maps, CompiledModelOptionMaps, ModelOptionMapSpecs, ModelOptionValues,
};
pub use types::{ModelOptionMapError, ModelOptionName, RestrictedCelError};

#[cfg(test)]
mod tests {
    use super::*;

    fn compile_map(
        source: &str,
        variable: ModelOptionName,
    ) -> Result<std::sync::Arc<ModelOptionMapProgram>, RestrictedCelError> {
        compile_model_option_map(source, variable)
    }

    #[test]
    fn a_simple_map_evaluates() {
        let program = compile_map(
            r#"{"max_tokens": maxOutputTokens}"#,
            ModelOptionName::MaxOutputTokens,
        )
        .unwrap();
        let output = program.evaluate(&serde_json::json!(8192)).unwrap();
        assert_eq!(output.get("max_tokens"), Some(&serde_json::json!(8192)));
    }

    #[test]
    fn a_conditional_map_selects_a_branch() {
        let program = compile_map(
            r#"reasoningLevel == "disabled"
              ? {"thinking": {"type": "disabled"}}
              : {"thinking": {"type": "enabled"}}"#,
            ModelOptionName::ReasoningLevel,
        )
        .unwrap();
        let output = program.evaluate(&serde_json::json!("disabled")).unwrap();
        assert_eq!(
            output.get("thinking").and_then(|t| t.get("type")),
            Some(&serde_json::json!("disabled"))
        );
        let output = program.evaluate(&serde_json::json!("high")).unwrap();
        assert_eq!(
            output.get("thinking").and_then(|t| t.get("type")),
            Some(&serde_json::json!("enabled"))
        );
    }

    #[test]
    fn non_object_results_are_rejected_at_compile_time() {
        assert!(compile_map(r#"reasoningLevel"#, ModelOptionName::ReasoningLevel).is_err());
        assert!(compile_map(r#"1 + 2"#, ModelOptionName::ReasoningLevel).is_err());
        // Conditionals are rejected when either branch is not an object.
        assert!(compile_map(r#"true ? {"a": 1} : 3"#, ModelOptionName::ReasoningLevel).is_err());
    }

    #[test]
    fn empty_and_unknown_identifiers_are_rejected() {
        assert!(compile_map("   ", ModelOptionName::ReasoningLevel).is_err());
        assert!(compile_map(r#"{"x": foo}"#, ModelOptionName::ReasoningLevel).is_err());
    }

    #[test]
    fn member_access_and_function_calls_are_rejected() {
        assert!(compile_map(
            r#"{"x": reasoningLevel.foo}"#,
            ModelOptionName::ReasoningLevel
        )
        .is_err());
        assert!(compile_map(r#"{"x": foo(1)}"#, ModelOptionName::ReasoningLevel).is_err());
    }

    #[test]
    fn integer_results_serialise_in_js_spelling() {
        // Regression: `JSON.stringify(4096)` writes "4096"; an f64-number would
        // serialise as "4096.0" and change the request bytes the patch emits.
        for (value, expected) in [
            (4096.0, "4096"),
            (-7.0, "-7"),
            (0.0, "0"),
            (-0.0, "0"),
            (0.5, "0.5"),
            (1.25, "1.25"),
        ] {
            let serialised =
                serde_json::to_string(&parser::number_value(value)).expect("serialise");
            assert_eq!(serialised, expected, "number_value({value})");
        }
    }

    #[test]
    fn an_integer_option_value_reaches_the_body_unscaled() {
        let specs = ModelOptionMapSpecs {
            reasoning_level_map: "{ \"effort\": reasoningLevel }",
            max_output_tokens_map: "{ 'max_tokens': maxOutputTokens }",
        };
        let compiled = compile_model_option_maps(&specs).expect("compile");
        let body: serde_json::Map<String, serde_json::Value> = serde_json::from_str("{}").unwrap();
        let patched = compiled
            .apply(
                &body,
                &ModelOptionValues {
                    reasoning_level: "high",
                    max_output_tokens: serde_json::json!(8192),
                },
            )
            .expect("apply");
        let bytes = serde_json::to_string(&serde_json::Value::Object(patched)).expect("bytes");
        assert!(
            bytes.contains("\"max_tokens\":8192"),
            "integer value must not gain a fraction: {bytes}"
        );
    }

    #[test]
    fn json_safe_number_arithmetic_parity() {
        let program = compile_map(r#"{"n": 1 / 0}"#, ModelOptionName::ReasoningLevel);
        // Infinity is a compile-time rejection? No: division is evaluated, so compile succeeds.
        let program = program.unwrap();
        assert!(program.evaluate(&serde_json::json!(0)).is_err());
    }

    #[test]
    fn merge_patch_conflicts_are_reported() {
        let body = serde_json::Map::new();
        let patches = vec![
            merge_patch::NamedJsonMergePatch {
                option: "a".into(),
                patch: serde_json::from_value(serde_json::json!({"x": {"y": 1}})).unwrap(),
            },
            merge_patch::NamedJsonMergePatch {
                option: "b".into(),
                patch: serde_json::from_value(serde_json::json!({"x": {"y": 2}})).unwrap(),
            },
        ];
        let error = merge_patch::apply_ordered_json_merge_patches(&body, &patches).unwrap_err();
        assert!(
            error.message.contains("conflicting JSON path $.x.y"),
            "{}",
            error.message
        );
    }

    #[test]
    fn merge_patch_null_deletes_and_empty_object_merges_shallow() {
        let mut body: serde_json::Map<String, serde_json::Value> =
            serde_json::from_value(serde_json::json!({"a": 1, "b": {"c": 2}})).unwrap();
        let patches = vec![merge_patch::NamedJsonMergePatch {
            option: "a".into(),
            patch: serde_json::from_value(serde_json::json!({"a": null, "b": {}})).unwrap(),
        }];
        let result = merge_patch::apply_ordered_json_merge_patches(&mut body, &patches).unwrap();
        assert_eq!(result.get("a"), None);
        // An empty patch object merges recursively into the existing value (the
        // TS `mergeObject` treats `{}` as a patch, not a reset).
        assert_eq!(result.get("b"), Some(&serde_json::json!({"c": 2})));
    }
}
