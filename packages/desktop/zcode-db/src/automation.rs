//! AutomationRepo pure helpers (slice 21). The domain row→`ZCodeAutomation` projection depends on
//! the shared `modelSelectionSchema`/cron subsystem and is a later slice; these backoff / stale-claim
//! computations are self-contained and correctness-critical, so they land first with tests.

/// Mirrors TS `DISPATCH_RETRY_BASE_MS`.
pub const DISPATCH_RETRY_BASE_MS: i64 = 30_000;
/// Mirrors TS `DISPATCH_RETRY_CAP_MS` (15 min).
pub const DISPATCH_RETRY_CAP_MS: i64 = 15 * 60_000;
/// Mirrors TS `CLAIM_STALE_MS` (10 min).
pub const CLAIM_STALE_MS: i64 = 10 * 60_000;

/// Port of `computeRetryAt`: exponential backoff `base * 2**max(0, attempts-1)` capped at
/// `DISPATCH_RETRY_CAP_MS`, added to `now`. The shift is clamped so a large `attempts` can't
/// overflow before the cap is applied (once `base << k` exceeds the cap it stays capped).
pub fn compute_retry_at(now: i64, attempts: i64) -> i64 {
    let exponent = (attempts - 1).max(0);
    let backoff = if exponent >= 16 {
        DISPATCH_RETRY_CAP_MS
    } else {
        (DISPATCH_RETRY_BASE_MS << exponent).min(DISPATCH_RETRY_CAP_MS)
    };
    now + backoff
}

/// The `stale` threshold param the claim/collect queries bind (`now - CLAIM_STALE_MS`).
pub fn claim_stale_threshold(now: i64) -> i64 {
    now - CLAIM_STALE_MS
}

// ---- ModelSelection (shared model-selection.ts schema; used by Automation + OffPeak columns) ----

/// `modelSelectionSchema.options` — strict object with an optional trimmed non-empty
/// `reasoningLevel`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_level: Option<String>,
}

/// `modelSelectionSchema` — strict `{ providerId, modelId, options? }`, trimmed non-empty scalars.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelection {
    pub provider_id: String,
    pub model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<SelectionOptions>,
}

fn nonempty_trim(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Port of `readSerializedModelSelection`. Parses + strict-validates the JSON column against
/// `modelSelectionSchema` semantics, returning `None` on: empty value, invalid JSON, unknown keys
/// (`.strict()`), non-string/empty `providerId`/`modelId`, a present-but-null/non-object `options`,
/// or a present-but-null/empty `reasoningLevel`. Parsing via `Value` (not `from_value`) so
/// present-`null` is distinguished from absent — serde would silently null-coalesce to absent.
pub fn read_serialized_model_selection(value: Option<&str>) -> Option<ModelSelection> {
    let raw = value.filter(|s| !s.is_empty())?;
    let json: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = json.as_object()?;
    for key in obj.keys() {
        if !matches!(key.as_str(), "providerId" | "modelId" | "options") {
            return None;
        }
    }
    let provider_id = obj
        .get("providerId")
        .and_then(serde_json::Value::as_str)
        .and_then(nonempty_trim)?;
    let model_id = obj
        .get("modelId")
        .and_then(serde_json::Value::as_str)
        .and_then(nonempty_trim)?;
    let options = match obj.get("options") {
        None => None,
        Some(serde_json::Value::Object(inner)) => {
            for k in inner.keys() {
                if k.as_str() != "reasoningLevel" {
                    return None;
                }
            }
            let reasoning_level = match inner.get("reasoningLevel") {
                None => None,
                Some(v) => Some(nonempty_trim(v.as_str()?)?),
            };
            Some(SelectionOptions { reasoning_level })
        }
        Some(_) => return None,
    };
    Some(ModelSelection {
        provider_id,
        model_id,
        options,
    })
}

/// Port of `serializeAutomationModelSelection`: validate-then-stringify; drops an empty `options`
/// object (TS only includes it when `Object.keys(options).length > 0`).
pub fn serialize_model_selection(selection: &ModelSelection) -> Option<String> {
    let trimmed = ModelSelection {
        provider_id: nonempty_trim(&selection.provider_id)?,
        model_id: nonempty_trim(&selection.model_id)?,
        options: selection
            .options
            .as_ref()
            .filter(|o| o.reasoning_level.is_some())
            .map(|o| SelectionOptions {
                reasoning_level: o.reasoning_level.clone(),
            }),
    };
    serde_json::to_string(&trimmed).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_backoff_doubles_then_caps() {
        assert_eq!(
            compute_retry_at(1000, 0),
            1000 + 30_000,
            "attempts<=1 → base"
        );
        assert_eq!(compute_retry_at(1000, 1), 1000 + 30_000);
        assert_eq!(compute_retry_at(0, 2), 60_000);
        assert_eq!(compute_retry_at(0, 3), 120_000);
        assert_eq!(compute_retry_at(0, 4), 240_000);
        assert_eq!(compute_retry_at(0, 5), 480_000);
        // 30_000 * 2^5 = 960_000 > cap → 900_000.
        assert_eq!(compute_retry_at(0, 6), DISPATCH_RETRY_CAP_MS);
        // A huge attempt count stays capped (no overflow).
        assert_eq!(compute_retry_at(0, 60), DISPATCH_RETRY_CAP_MS);
    }

    #[test]
    fn stale_threshold_subtracts_ten_minutes() {
        assert_eq!(claim_stale_threshold(1_000_000), 1_000_000 - CLAIM_STALE_MS);
    }

    #[test]
    fn reads_valid_model_selection_and_trims() {
        let ms = read_serialized_model_selection(Some(
            r#"{"providerId":" account:zai ","modelId":"GLM-5","options":{"reasoningLevel":" high "}}"#,
        ))
        .unwrap();
        assert_eq!(ms.provider_id, "account:zai");
        assert_eq!(ms.model_id, "GLM-5");
        assert_eq!(
            ms.options.as_ref().unwrap().reasoning_level.as_deref(),
            Some("high")
        );
    }

    #[test]
    fn rejects_strict_violations_and_nulls() {
        // Unknown top-level key (strict).
        assert!(
            read_serialized_model_selection(Some(r#"{"providerId":"p","modelId":"m","x":1}"#))
                .is_none()
        );
        // Empty / non-string required field.
        assert!(
            read_serialized_model_selection(Some(r#"{"providerId":"  ","modelId":"m"}"#)).is_none()
        );
        assert!(
            read_serialized_model_selection(Some(r#"{"providerId":1,"modelId":"m"}"#)).is_none()
        );
        // options present but null → zod optional rejects null → None.
        assert!(read_serialized_model_selection(Some(
            r#"{"providerId":"p","modelId":"m","options":null}"#
        ))
        .is_none());
        // reasoningLevel present but empty → min(1) fails → None.
        assert!(read_serialized_model_selection(Some(
            r#"{"providerId":"p","modelId":"m","options":{"reasoningLevel":" "}}"#
        ))
        .is_none());
        // Invalid JSON / empty value.
        assert!(read_serialized_model_selection(Some("not json")).is_none());
        assert!(read_serialized_model_selection(None).is_none());
        // The default backfill writes the literal string "null" → JSON.parse null → not object → None.
        assert!(read_serialized_model_selection(Some("null")).is_none());
    }

    #[test]
    fn accepts_options_absent_and_empty_options() {
        let a =
            read_serialized_model_selection(Some(r#"{"providerId":"p","modelId":"m"}"#)).unwrap();
        assert!(a.options.is_none());
        // options {} is a valid object with no reasoningLevel.
        let b = read_serialized_model_selection(Some(
            r#"{"providerId":"p","modelId":"m","options":{}}"#,
        ))
        .unwrap();
        assert_eq!(b.options.unwrap().reasoning_level, None);
    }

    #[test]
    fn serialize_drops_empty_options_and_key_order() {
        let ms = ModelSelection {
            provider_id: "p".into(),
            model_id: "m".into(),
            options: Some(SelectionOptions {
                reasoning_level: None,
            }),
        };
        assert_eq!(
            serialize_model_selection(&ms).unwrap(),
            r#"{"providerId":"p","modelId":"m"}"#
        );
        let with = ModelSelection {
            provider_id: " p ".into(),
            model_id: "m".into(),
            options: Some(SelectionOptions {
                reasoning_level: Some("high".into()),
            }),
        };
        assert_eq!(
            serialize_model_selection(&with).unwrap(),
            r#"{"providerId":"p","modelId":"m","options":{"reasoningLevel":"high"}}"#
        );
    }
}
