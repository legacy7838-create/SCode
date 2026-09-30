//! `0002_provider_selection` — the frozen legacy-selection decoder and its payload.
//!
//! Spec: docs/specs/rust-native-task-index.md §28.
//!
//! This is a transcription of the deleted
//! `packages/services/src/session/tasksDatabase/provider-selection-v2.ts`. It is **frozen
//! history, not a live migration**: every existing install has `0002` applied, and the decoder is
//! a record of the one historical transformation the ledger describes. The native runner needs
//! that same transformation as a payload it can execute, so the rules live here and are applied
//! by [`crate::migrate::run_migrations`] when `0002` is pending.
//!
//! The decoder's escaping order and identity table are transcribed verbatim — including the
//! deliberate rejection of `provider=glm`/`zcode` (the old *execution backend*, not a provider
//! identity). Getting any of these wrong does not fail a unit test on an already-migrated
//! machine; it fails on a user whose old row would have decoded differently.

use rusqlite::Connection;
use serde_json::{json, Map, Value};

/// The runtime parser / identity tables may not be called: this is the pre-release adjudicated
/// encoding, frozen. Keep the escaping and delimiting priorities consistent with the old
/// `decodeCustomModelValue` / `parseModelPickerValue`.
const PROVIDER_NAMES: &[(&str, &str)] = &[
    ("builtin:bigmodel", "bigmodel-api"),
    ("builtin:zai", "zai-api"),
    ("builtin:bigmodel-start-plan", "account:bigmodel-start-plan"),
    ("builtin:zai-start-plan", "account:zai-start-plan"),
    (
        "builtin:bigmodel-coding-plan",
        "account:bigmodel-individual-coding-plan",
    ),
    (
        "builtin:zai-coding-plan",
        "account:zai-individual-coding-plan",
    ),
];

/// One row `0002` considers: the legacy columns, only where `model` is not SQL NULL.
#[derive(Debug, Clone, PartialEq)]
pub struct LegacySelectionRow {
    pub automation_id: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub thought_level: Option<String>,
}

/// `LEGACY_SELECTION_SOURCE_SQL` — the rows `0002` reads.
pub const LEGACY_SELECTION_SOURCE_SQL: &str =
    "SELECT automation_id, model, provider, thought_level FROM automations WHERE model IS NOT NULL";

/// `decodeURIComponent` for a value that may be malformed; the original returns the raw value on
/// a throw rather than propagating.
fn decode_component(value: &str) -> String {
    percent_decode(value).unwrap_or_else(|| value.to_string())
}

/// A minimal `decodeURIComponent` equivalent.
///
/// `decodeURIComponent` throws on malformed input and on lone `%`; the original caught the throw
/// and returned the raw value. Matching that edge exactly is why this returns `Option` rather
/// than a lossy replacement.
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = (bytes[index + 1] as char).to_digit(16)?;
            let low = (bytes[index + 2] as char).to_digit(16)?;
            out.push((high * 16 + low) as u8);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    // `decodeURIComponent` decodes to a JS string; invalid UTF-8 is a throw there, so return the
    // raw value (`None`) rather than a lossy U+FFFD.
    String::from_utf8(out).ok()
}

fn provider_name(provider: &str) -> Option<&'static str> {
    PROVIDER_NAMES
        .iter()
        .find(|(key, _)| *key == provider)
        .map(|(_, value)| *value)
}

/// The decoded selection, or `None` when the legacy identity cannot be determined.
///
/// The `Some(Value)` is `ModelSelection` as JSON; `{"providerId": ..., "modelId": ...}` with an
/// optional `options.reasoningLevel`. The frozen rules write SQL `NULL` for `None`.
fn decode_legacy_selection(row: &LegacySelectionRow) -> Option<Value> {
    let value = row.model.as_deref()?.trim();
    if value.is_empty() {
        return None;
    }
    let mut provider = row.provider.as_deref().unwrap_or("").trim().to_string();
    let mut model = value.to_string();
    let mut reasoning_level = row
        .thought_level
        .as_deref()
        .map(|level| level.trim().to_string())
        .filter(|level| !level.is_empty());

    if let Some(body) = value.strip_prefix("custom:") {
        let Some(separator) = body.find(':') else {
            return None;
        };
        let parts: Vec<&str> = body.split(':').collect();
        if parts.len() >= 3 && parts[0] == "builtin" {
            provider = format!("builtin:{}", parts[1]);
            model = decode_component(&parts[2..].join(":"));
        } else {
            provider = decode_component(&body[..separator]);
            model = decode_component(&body[separator + 1..]);
        }
    } else if let Some(separator) = value.find('/') {
        provider = value[..separator].to_string();
        model = value[separator + 1..].to_string();
        if let Some(level_separator) = model.find('$') {
            if level_separator > 0 && level_separator < model.len() - 1 {
                reasoning_level = Some(model[level_separator + 1..].trim().to_string());
                if reasoning_level.as_deref().is_none_or(str::is_empty) {
                    return None;
                }
                model = model[..level_separator].to_string();
            }
        }
    } else if provider == "glm" || provider == "zcode" {
        // The old provider=glm/zcode is the execution backend, not the provider identity.
        return None;
    }

    let provider = provider.trim();
    let model = model.trim();
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    let provider_id = if let Some(stripped) = provider.strip_prefix("builtin:") {
        let key = format!("builtin:{stripped}");
        provider_name(&key)?
    } else {
        provider
    };
    if provider_id.is_empty() {
        return None;
    }

    let mut object = Map::new();
    object.insert("providerId".into(), Value::String(provider_id.to_string()));
    object.insert("modelId".into(), Value::String(model.to_string()));
    if let Some(level) = reasoning_level {
        if !level.is_empty() {
            object.insert("options".into(), json!({ "reasoningLevel": level }));
        }
    }
    Some(Value::Object(object))
}

/// The decoded selections for the rows, in input order.
fn legacy_selection_rules(
    rows: &[LegacySelectionRow],
) -> Vec<(LegacySelectionRow, Option<Value>)> {
    rows.iter()
        .map(|row| (row.clone(), decode_legacy_selection(row)))
        .collect()
}

/// A SQL string literal; `''` is only emitted for input that cannot be stored verbatim anyway.
fn sql_text(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// A SQL `TEXT` literal encoding a JSON payload, escaping-free through `hex()`.
fn sql_json(json: &str) -> String {
    let hex: String = json
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("CAST(X'{hex}' AS TEXT)")
}

fn sql_nullable_text(value: Option<&str>) -> String {
    match value {
        None => "NULL".to_string(),
        Some(value) => sql_json(value),
    }
}

/// The `0002` body as emitted SQL.
///
/// `existing` is the stored `model_selection` per automation, embedded rather than re-read, and
/// that is exact rather than an approximation: each `UPDATE` is guarded by
/// `model IS ? AND provider IS ? AND thought_level IS ?`, so a statement can only take effect
/// while the row still holds the snapshot the rule was built from. `None` means the column is SQL
/// NULL.
pub fn legacy_selection_sql(
    rows: &[LegacySelectionRow],
    existing: &std::collections::HashMap<String, Option<String>>,
) -> String {
    let mut statements: Vec<String> = Vec::new();
    for (row, decoded) in legacy_selection_rules(rows) {
        match decoded {
            None => {
                let model = row.model.as_deref().map(str::trim).unwrap_or("");
                if model.is_empty() {
                    continue;
                }
                // Frozen semantics: an old explicit intention whose identity cannot be
                // determined is cleared, rather than guessed at.
                if existing.get(&row.automation_id).is_some_and(Option::is_none) {
                    continue;
                }
                statements.push(format!(
                    "UPDATE automations SET model_selection=NULL WHERE automation_id={};",
                    sql_text(&row.automation_id)
                ));
            }
            Some(decoded) => {
                let decoded = serde_json::to_string(&decoded).expect("selection serialises");
                if existing
                    .get(&row.automation_id)
                    .is_some_and(|value| value.as_deref() == Some(decoded.as_str()))
                {
                    continue;
                }
                statements.push(format!(
                    "UPDATE automations SET model_selection={} WHERE automation_id={} AND model IS {} AND provider IS {} AND thought_level IS {};",
                    sql_json(&decoded),
                    sql_text(&row.automation_id),
                    sql_nullable_text(row.model.as_deref()),
                    sql_nullable_text(row.provider.as_deref()),
                    sql_nullable_text(row.thought_level.as_deref()),
                ));
            }
        }
    }
    // The final sweep is unconditional and idempotent in both implementations.
    statements.push(
        "UPDATE automations SET model_selection='null'\n    WHERE model_selection IS NULL AND (model IS NULL OR trim(model)='');"
            .to_string(),
    );
    statements.join("\n")
}

/// Reads the rows `0002` considers from a live connection.
///
/// A **fresh** file has no `automations` table when the payload is built (the list is assembled
/// before `0001` runs). That is not an error: the deleted TypeScript passed `undefined` and got
/// `[]`, and `0001` creates the table before `0002` executes.
fn table_exists(connection: &Connection, table: &str) -> Result<bool, rusqlite::Error> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            rusqlite::params![table],
            |_| Ok(true),
        )
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(false),
            other => Err(other),
        })
}

pub fn read_legacy_selection_rows(
    connection: &Connection,
) -> Result<Vec<LegacySelectionRow>, rusqlite::Error> {
    if !table_exists(connection, "automations")? {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare(LEGACY_SELECTION_SOURCE_SQL)?;
    let rows = statement.query_map([], |row| {
        Ok(LegacySelectionRow {
            automation_id: row.get(0)?,
            model: row.get(1)?,
            provider: row.get(2)?,
            thought_level: row.get(3)?,
        })
    })?;
    rows.collect()
}

/// What each automation's `model_selection` already holds, so `0002` can skip an update that
/// would write the value that is already there. Only rows whose legacy columns are present are
/// needed — the `IS`-guard means an update for any other row could not take effect anyway.
pub fn read_selection_pre_image(
    connection: &Connection,
) -> Result<std::collections::HashMap<String, Option<String>>, rusqlite::Error> {
    if !table_exists(connection, "automations")? {
        return Ok(std::collections::HashMap::new());
    }
    let mut statement = connection.prepare(
        "SELECT a.automation_id AS automation_id, a.model_selection AS model_selection
       FROM automations a WHERE a.model IS NOT NULL",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    let mut existing = std::collections::HashMap::new();
    for row in rows {
        let (automation_id, model_selection) = row?;
        existing.insert(automation_id, model_selection);
    }
    Ok(existing)
}

/// The `0002` payload for a live connection: read the rows and the pre-image, then emit.
///
/// The delete of the JavaScript runner means this is the **only** implementation; the frozen
/// rule set exists once.
pub fn migration_0002_sql(connection: &Connection) -> Result<String, rusqlite::Error> {
    let rows = read_legacy_selection_rows(connection)?;
    let existing = read_selection_pre_image(connection)?;
    Ok(legacy_selection_sql(&rows, &existing))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(
        automation_id: &str,
        model: Option<&str>,
        provider: Option<&str>,
        level: Option<&str>,
    ) -> LegacySelectionRow {
        LegacySelectionRow {
            automation_id: automation_id.to_string(),
            model: model.map(str::to_string),
            provider: provider.map(str::to_string),
            thought_level: level.map(str::to_string),
        }
    }

    fn decode(model: &str, provider: Option<&str>, level: Option<&str>) -> Option<Value> {
        decode_legacy_selection(&row("a", Some(model), provider, level))
    }

    /// A plain `provider/model` value.
    #[test]
    fn a_slash_form_decodes_to_provider_and_model() {
        assert_eq!(
            decode("openai/gpt-5", None, None),
            Some(json!({"providerId": "openai", "modelId": "gpt-5"}))
        );
    }

    /// `$reasoningLevel` is split off the model id.
    #[test]
    fn a_reasoning_level_suffix_is_split_off() {
        assert_eq!(
            decode("openai/gpt-5$high", None, None),
            Some(json!({
                "providerId": "openai",
                "modelId": "gpt-5",
                "options": {"reasoningLevel": "high"}
            }))
        );
    }

    /// `custom:builtin:<name>:<model>` maps the builtin name through the identity table.
    #[test]
    fn a_custom_builtin_form_maps_through_the_identity_table() {
        assert_eq!(
            decode("custom:builtin:bigmodel:glm-4.6", None, None),
            Some(json!({"providerId": "bigmodel-api", "modelId": "glm-4.6"}))
        );
    }

    /// `custom:<provider>:<model>` percent-decodes both halves.
    #[test]
    fn a_custom_form_percent_decodes() {
        assert_eq!(
            decode("custom:open%20ai:gpt%2F5", None, None),
            Some(json!({"providerId": "open ai", "modelId": "gpt/5"}))
        );
    }

    /// `provider=glm` / `zcode` is the execution backend, not an identity — rejected.
    #[test]
    fn the_backend_provider_is_rejected() {
        assert_eq!(decode("glm-4.6", Some("glm"), None), None);
        assert_eq!(decode("glm-4.6", Some("zcode"), None), None);
    }

    /// A custom value with no separator is undecodable.
    #[test]
    fn a_custom_value_without_a_separator_is_rejected() {
        assert_eq!(decode("custom:nocolon", None, None), None);
    }

    /// The emitted SQL is the frozen shape: a hex-encoded JSON literal and the IS-guard.
    #[test]
    fn the_emitted_sql_uses_hex_and_the_is_guard() {
        let rows = vec![row("a1", Some("openai/gpt-5"), None, None)];
        let existing = std::collections::HashMap::new();
        let sql = legacy_selection_sql(&rows, &existing);
        assert!(sql.contains("UPDATE automations SET model_selection=CAST(X'"), "{sql}");
        assert!(sql.contains("AND model IS CAST(X'"), "{sql}");
        assert!(sql.contains("provider IS NULL"), "{sql}");
        assert!(
            sql.contains("model_selection IS NULL AND (model IS NULL OR trim(model)='')"),
            "{sql}"
        );
    }

    /// An undecodable explicit intention is cleared, not guessed.
    #[test]
    fn an_undecodable_row_is_cleared() {
        let rows = vec![row("a1", Some("glm-4.6"), Some("glm"), None)];
        let existing = std::collections::HashMap::new();
        let sql = legacy_selection_sql(&rows, &existing);
        assert!(sql.contains("SET model_selection=NULL WHERE automation_id='a1'"), "{sql}");
    }

    /// The pre-image size guard skips an update that would write what is already there.
    #[test]
    fn the_pre_image_skips_a_no_op_update() {
        let rows = vec![row("a1", Some("openai/gpt-5"), None, None)];
        let mut existing = std::collections::HashMap::new();
        existing.insert(
            "a1".to_string(),
            Some(r#"{"providerId":"openai","modelId":"gpt-5"}"#.to_string()),
        );
        let sql = legacy_selection_sql(&rows, &existing);
        assert!(!sql.contains("automation_id='a1'"), "{sql}");
    }

    /// Differential vectors captured from the deleted TypeScript `legacySelectionRules`
    /// (`provider-selection-v2.ts`) before deletion. Pinned so the Rust decode cannot drift.
    #[test]
    fn the_decode_matches_the_deleted_typescript_vectors() {
        let vectors: &[(&str, Option<&str>, Option<&str>, &str)] = &[
            ("openai/gpt-5", None, None, "{\"providerId\":\"openai\",\"modelId\":\"gpt-5\"}"),
            ("openai/gpt-5$high", None, None, "{\"providerId\":\"openai\",\"modelId\":\"gpt-5\",\"options\":{\"reasoningLevel\":\"high\"}}"),
            ("openai/gpt-5$", None, None, "{\"providerId\":\"openai\",\"modelId\":\"gpt-5$\"}"),
            ("custom:builtin:bigmodel:glm-4.6", None, None, "{\"providerId\":\"bigmodel-api\",\"modelId\":\"glm-4.6\"}"),
            ("custom:open%20ai:gpt%2F5", None, None, "{\"providerId\":\"open ai\",\"modelId\":\"gpt/5\"}"),
            ("glm-4.6", Some("glm"), None, "null"),
            ("glm-4.6", Some("zcode"), None, "null"),
            ("custom:nocolon", None, None, "null"),
            ("custom:builtin:zai:glm-4.5$x", None, Some("low"), "{\"providerId\":\"zai-api\",\"modelId\":\"glm-4.5$x\",\"options\":{\"reasoningLevel\":\"low\"}}"),
            ("provider/model/with/slashes", None, None, "{\"providerId\":\"provider\",\"modelId\":\"model/with/slashes\"}"),
            ("a/b$c$d", None, None, "{\"providerId\":\"a\",\"modelId\":\"b\",\"options\":{\"reasoningLevel\":\"c$d\"}}"),
            ("custom:builtin:bigmodel-start-plan:model%3Awith%3Acolons", None, None, "{\"providerId\":\"account:bigmodel-start-plan\",\"modelId\":\"model:with:colons\"}"),
            ("  openai / gpt-5  ", Some("  "), Some("  high  "), "{\"providerId\":\"openai\",\"modelId\":\"gpt-5\",\"options\":{\"reasoningLevel\":\"high\"}}"),
            ("builtin:zai/model", None, None, "{\"providerId\":\"zai-api\",\"modelId\":\"model\"}"),
            ("", None, None, "null"),
            ("x", Some("unknown-provider"), None, "{\"providerId\":\"unknown-provider\",\"modelId\":\"x\"}"),
            ("custom:%E4%B8%AD:model", None, None, "{\"providerId\":\"中\",\"modelId\":\"model\"}"),
            ("custom:builtin:bad-table:model", None, None, "null"),
            ("foo/bar$baz$qux", None, Some("level"), "{\"providerId\":\"foo\",\"modelId\":\"bar\",\"options\":{\"reasoningLevel\":\"baz$qux\"}}"),
            ("custom:builtin:bigmodel:glm-4.6$low", None, Some("low"), "{\"providerId\":\"bigmodel-api\",\"modelId\":\"glm-4.6$low\",\"options\":{\"reasoningLevel\":\"low\"}}"),
        ];
        for (model, provider, level, expected) in vectors {
            let decoded = decode_legacy_selection(&row("a", Some(model), *provider, *level));
            let expected: Value = serde_json::from_str(expected).expect("expected json");
            let actual = decoded.unwrap_or(Value::Null);
            assert_eq!(
                actual, expected,
                "model={model:?} provider={provider:?} level={level:?}"
            );
        }
    }
}
