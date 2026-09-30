use napi_derive::napi;
use serde_json::Value as JsonValue;

/// Filter deltas by delivery profile.
///
/// `row.delta` entries are filtered by `stream_paths`; all other structural
/// operations pass through unchanged. Pure function — does not mutate inputs.
///
/// Mirrors `filterConversationDeltasForProfile` in
/// `packages/shared/src/zcode-protocol-v4/profiles.ts`.
#[napi]
pub fn filter_deltas_for_profile(
    deltas: Vec<JsonValue>,
    stream_paths: Vec<String>,
) -> Vec<JsonValue> {
    deltas
        .into_iter()
        .filter(|delta| {
            let op = delta["op"].as_str().unwrap_or("");
            if op == "row.delta" {
                let path = delta["path"].as_str().unwrap_or("");
                stream_paths.iter().any(|p| p == path)
            } else {
                true
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn passes_non_row_delta() {
        let deltas = vec![json!({"op": "row.upserted"}), json!({"op": "snapshot"})];
        let result = filter_deltas_for_profile(deltas, vec!["text".into()]);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn filters_row_delta_by_path() {
        let deltas = vec![
            json!({"op": "row.delta", "path": "text"}),
            json!({"op": "row.delta", "path": "inputText"}),
            json!({"op": "row.delta", "path": "output.text"}),
        ];
        let result = filter_deltas_for_profile(deltas, vec!["text".into(), "output.text".into()]);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["path"], "text");
        assert_eq!(result[1]["path"], "output.text");
    }

    #[test]
    fn empty_stream_paths_filters_all_row_delta() {
        let deltas = vec![
            json!({"op": "row.delta", "path": "text"}),
            json!({"op": "row.upserted"}),
        ];
        let result = filter_deltas_for_profile(deltas, vec![]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["op"], "row.upserted");
    }
}
