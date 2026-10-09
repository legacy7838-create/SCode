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

// ---- Automation domain projection + read (rowToAutomation / listAutomations) ----

use rusqlite::Connection;

/// A scheduled-rule is stored as JSON; carried as an opaque value (the TS read casts it through).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub automation_id: String,
    pub title: String,
    pub cron_expr: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<ModelSelection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    pub workspace_key: String,
    pub workspace_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_task_id: Option<String>,
    pub location_kind: String,
    pub recurring: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_runs: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_rule: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_edited_by_user: Option<bool>,
    pub run_count: i64,
    pub enabled: bool,
    pub lifecycle_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<i64>,
    pub dispatch_status: String,
    pub dispatch_attempts: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Port of `normalizeAutomationMode`: a stored `mode` outside `zcodeTaskModeSchema` (incl. the
/// historical empty string) reads as unset rather than crashing `automation/list`.
fn normalize_automation_mode(mode: Option<&str>) -> Option<String> {
    mode.filter(|m| crate::VALID_MODES.contains(m))
        .map(str::to_string)
}

/// The columns `rowToAutomation` reads, in a fixed order (a `SELECT *` would bind to the table's
/// column order; naming them keeps the positional mapping stable across schema additions).
const AUTOMATION_COLUMNS: &str = "automation_id, title, cron_expr, prompt, model_selection, mode, \
     workspace_key, workspace_path, workspace_identity, target_task_id, location_kind, recurring, \
     max_runs, end_at, schedule_rule, schedule_edited_by_user, run_count, enabled, lifecycle_status, \
     next_run_at, last_run_at, dispatch_status, dispatch_attempts, retry_at, last_error, created_at, \
     updated_at";

fn str_or(r: &rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<String> {
    r.get::<_, Option<String>>(idx)
        .map(|v| v.unwrap_or_default())
}

fn map_automation_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Automation> {
    let schedule_rule_json: Option<String> = r.get(14)?;
    Ok(Automation {
        automation_id: r.get(0)?,
        title: str_or(r, 1)?,
        cron_expr: str_or(r, 2)?,
        prompt: str_or(r, 3)?,
        model_selection: read_serialized_model_selection(r.get::<_, Option<String>>(4)?.as_deref()),
        mode: normalize_automation_mode(r.get::<_, Option<String>>(5)?.as_deref()),
        workspace_key: str_or(r, 6)?,
        workspace_path: str_or(r, 7)?,
        workspace_identity: r.get(8)?,
        target_task_id: r.get(9)?,
        location_kind: if r.get::<_, Option<String>>(10)?.as_deref() == Some("remote") {
            "remote".to_string()
        } else {
            "local".to_string()
        },
        recurring: r.get::<_, i64>(11).unwrap_or(0) == 1,
        max_runs: r.get(12)?,
        end_at: r.get(13)?,
        schedule_rule: schedule_rule_json
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    14,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?,
        schedule_edited_by_user: (r.get::<_, i64>(15).unwrap_or(0) == 1).then_some(true),
        run_count: r.get::<_, i64>(16).unwrap_or(0),
        enabled: r.get::<_, i64>(17).unwrap_or(0) == 1,
        lifecycle_status: str_or(r, 18)?,
        next_run_at: r.get(19)?,
        last_run_at: r.get(20)?,
        dispatch_status: str_or(r, 21)?,
        dispatch_attempts: r.get::<_, i64>(22).unwrap_or(0),
        retry_at: r.get(23)?,
        last_error: r.get(24)?,
        created_at: r.get(25)?,
        updated_at: r.get(26)?,
    })
}

/// Port of `listAutomations`: `WHERE (@workspace_key IS NULL OR workspace_key=@workspace_key)
/// ORDER BY created_at DESC`, projected through `rowToAutomation`. A `schedule_rule` that isn't
/// valid JSON surfaces as an error (the TS `JSON.parse` would throw), rather than silently dropping
/// the row.
pub fn list_automations(
    conn: &Connection,
    workspace_key: Option<&str>,
) -> std::result::Result<Vec<Automation>, String> {
    let sql = format!(
        "SELECT {AUTOMATION_COLUMNS} FROM automations \
         WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key) ORDER BY created_at DESC"
    );
    let wk = workspace_key
        .map(|s| rusqlite::types::Value::Text(s.to_string()))
        .unwrap_or(rusqlite::types::Value::Null);
    let params: Vec<(&str, &dyn rusqlite::types::ToSql)> = vec![("@workspace_key", &wk)];
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params.as_slice(), map_automation_row)
        .map_err(|e| e.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Port of `getAutomation` — a single row by id (+ optional workspace key), `None` when absent.
pub fn get_automation(
    conn: &Connection,
    automation_id: &str,
    workspace_key: Option<&str>,
) -> std::result::Result<Option<Automation>, String> {
    let sql = format!(
        "SELECT {AUTOMATION_COLUMNS} FROM automations WHERE automation_id = @automation_id \
         AND (@workspace_key IS NULL OR workspace_key = @workspace_key)"
    );
    let aid = rusqlite::types::Value::Text(automation_id.to_string());
    let wk = workspace_key
        .map(|s| rusqlite::types::Value::Text(s.to_string()))
        .unwrap_or(rusqlite::types::Value::Null);
    let params: Vec<(&str, &dyn rusqlite::types::ToSql)> =
        vec![("@automation_id", &aid), ("@workspace_key", &wk)];
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params.as_slice(), map_automation_row)
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(r) => r.map(Some).map_err(|e| e.to_string()),
        None => Ok(None),
    }
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

    fn automations_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::adopt_schema(&conn).unwrap();
        conn
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_automation(
        conn: &Connection,
        id: &str,
        mode: Option<&str>,
        model_selection: Option<&str>,
        schedule_rule: Option<&str>,
        recurring: i64,
        location: &str,
    ) {
        conn.execute(
            "INSERT INTO automations (automation_id, title, cron_expr, prompt, mode, model_selection, \
             workspace_key, workspace_path, location_kind, recurring, run_count, enabled, \
             lifecycle_status, dispatch_status, dispatch_attempts, created_at, updated_at, \
             schedule_rule, schedule_edited_by_user) \
             VALUES (?1,'t','* * * * *','p',?2,?3,'wk','/w',?4,?5,3,1,'active','idle',0,10,20,?6,1)",
            rusqlite::params![id, mode, model_selection, location, recurring, schedule_rule],
        )
        .unwrap();
    }

    #[test]
    fn row_to_automation_projection() {
        let conn = automations_db();
        insert_automation(
            &conn,
            "a1",
            Some("build"),
            Some(r#"{"providerId":"account:zai","modelId":"GLM-5"}"#),
            Some(r#"{"kind":"weekly"}"#),
            1,
            "remote",
        );
        let all = list_automations(&conn, None).unwrap();
        assert_eq!(all.len(), 1);
        let a = &all[0];
        assert_eq!(a.automation_id, "a1");
        assert_eq!(a.mode.as_deref(), Some("build"));
        assert_eq!(a.location_kind, "remote");
        assert!(a.recurring);
        assert!(a.enabled);
        assert_eq!(a.run_count, 3);
        assert_eq!(a.schedule_edited_by_user, Some(true));
        assert_eq!(a.model_selection.as_ref().unwrap().model_id, "GLM-5");
        assert_eq!(a.schedule_rule, Some(serde_json::json!({"kind":"weekly"})));
        assert_eq!(list_automations(&conn, Some("wk")).unwrap().len(), 1);
        assert!(list_automations(&conn, Some("other")).unwrap().is_empty());
    }

    #[test]
    fn projection_normalizes_bad_mode_and_errors_on_bad_schedule_rule() {
        let conn = automations_db();
        insert_automation(&conn, "a2", Some("bogus"), None, None, 0, "local");
        let a = &list_automations(&conn, Some("wk")).unwrap()[0];
        assert_eq!(a.mode, None, "invalid mode → unset");
        assert_eq!(a.location_kind, "local");

        insert_automation(
            &conn,
            "a3",
            Some("plan"),
            None,
            Some("{not json"),
            0,
            "local",
        );
        assert!(list_automations(&conn, Some("wk")).is_err());
    }
}
