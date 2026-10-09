//! Rust port of `@zcode/shared/model-selection`'s `modelSelectionSchema.safeParse` + `parseModelSelectionValue`
//! (`contracts/model/model.ts`). Zod `.strict()` + `.trim().min(1)` semantics: unknown keys reject;
//! required strings must be present, trim to non-empty; optional `options` (strict) may hold an
//! optional trimmed non-empty `reasoningLevel`; a present-but-`null` optional/inner value REJECTS
//! (zod `.optional()` accepts only `undefined`, i.e. key absent). Output is a FRESH object built in
//! schema-declaration key order (providerId, modelId, options) with trimmed values — NOT the input's
//! key order. `parse_model_selection_value` returns `Some(normalized)` on success, `None` on failure,
//! matching `parsed.success ? parsed.data : undefined`.

use serde_json::{Map, Value, json};

/// `modelSelectionSchema.safeParse(value)` → the normalized `ModelSelection` object, or `None`.
pub fn parse_model_selection_value(value: &Value) -> Option<Value> {
    let obj = value.as_object()?;
    // strict: only providerId, modelId, options allowed at the top level.
    if obj.keys().any(|k| !matches!(k.as_str(), "providerId" | "modelId" | "options")) {
        return None;
    }
    let provider_id = trim_nonempty(obj.get("providerId")?)?;
    let model_id = trim_nonempty(obj.get("modelId")?)?;

    let mut out = Map::new();
    out.insert("providerId".into(), json!(provider_id));
    out.insert("modelId".into(), json!(model_id));

    // `.optional()` → key must be absent (undefined) OR satisfy the strict options object. A present
    // JSON `null` is NOT undefined → reject.
    if let Some(opts) = obj.get("options") {
        let oo = opts.as_object()?;
        if oo.keys().any(|k| k != "reasoningLevel") {
            return None;
        }
        let mut om = Map::new();
        if let Some(rl) = oo.get("reasoningLevel") {
            let trimmed = trim_nonempty(rl)?;
            om.insert("reasoningLevel".into(), json!(trimmed));
        }
        out.insert("options".into(), Value::Object(om));
    }
    Some(Value::Object(out))
}

/// A `string().trim().min(1)` value: must be a string whose trimmed form is non-empty. Returns the
/// trimmed string (`None` otherwise, incl. non-string or `null`).
fn trim_nonempty(value: &Value) -> Option<String> {
    let s = value.as_str()?;
    let t = s.trim();
    if t.is_empty() { None } else { Some(t.to_string()) }
}
