//! JSONC parsing and the config-file readers shared by the terminal detectors.
//!
//! Ported from `packages/services/src/terminal/terminalProfile.ts:79-192`:
//! `stripJsonComments`, `removeJsonTrailingCommas`, `parseJsonc`, `readJsoncFile`,
//! `readObjectFile` and `readNestedString`.

use std::path::Path;

use serde_json::Value;

use crate::jsval::{is_js_space, js_trim};

/// `normalizeFontFamily`: trim, and treat blank as absent.
pub fn normalize_font_family(value: Option<&str>) -> Option<String> {
    let trimmed = js_trim(value?);
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

/// `stripJsonComments` — line and block comments removed, string literals preserved.
///
/// Transcribed over `char`s rather than UTF-16 code units. The only characters the algorithm
/// inspects are ASCII, and a surrogate pair cannot be mistaken for `"` or `/`, so the two
/// indexings agree; the emitted string is the concatenation of the same characters.
pub fn strip_json_comments(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut result = String::with_capacity(raw.len());
    let mut in_string = false;
    let mut escaped = false;
    let mut index = 0usize;

    while index < chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();
        if in_string {
            result.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if ch == '"' {
            in_string = true;
            result.push(ch);
        } else if ch == '/' && next == Some('/') {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            result.push('\n');
        } else if ch == '/' && next == Some('*') {
            index += 2;
            while index < chars.len() && !(chars[index] == '*' && chars.get(index + 1) == Some(&'/'))
            {
                index += 1;
            }
            index += 1;
        } else {
            result.push(ch);
        }
        index += 1;
    }
    result
}

/// `removeJsonTrailingCommas` — a `,` immediately before a `}` or `]` is dropped.
pub fn remove_json_trailing_commas(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut result = String::with_capacity(raw.len());
    let mut in_string = false;
    let mut escaped = false;
    let mut index = 0usize;

    while index < chars.len() {
        let ch = chars[index];
        if in_string {
            result.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if ch == '"' {
            in_string = true;
        }
        if ch == ',' {
            let mut next_index = index + 1;
            while chars
                .get(next_index)
                .copied()
                .is_some_and(|candidate| is_js_space(candidate))
            {
                next_index += 1;
            }
            if matches!(chars.get(next_index), Some('}') | Some(']')) {
                index += 1;
                continue;
            }
        }
        result.push(ch);
        index += 1;
    }
    result
}

/// `parseJsonc` — attempt the raw text first, then the comment-stripped and
/// de-comma'd text. The order is observable and is preserved: a file that is already strict
/// JSON never reaches the stripper.
pub fn parse_jsonc(raw: &str) -> Option<Value> {
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) {
        return Some(Value::Object(map));
    }
    let cleaned = remove_json_trailing_commas(&strip_json_comments(raw));
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&cleaned) {
        return Some(Value::Object(map));
    }
    None
}

/// `existsSync` + `readFileSync(path, "utf8")` + the `catch → null` of the legacy readers.
///
/// The decode is lossy on purpose: Node's UTF-8 decode replaces invalid sequences with
/// U+FFFD and succeeds, where `read_to_string` would refuse the file outright.
pub fn read_text_file(file_path: &str) -> Option<String> {
    if !Path::new(file_path).exists() {
        return None;
    }
    std::fs::read(file_path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// `readJsoncFile`.
pub fn read_jsonc_file(file_path: &str) -> Option<Value> {
    parse_jsonc(&read_text_file(file_path)?)
}

/// `readObjectFile(filePath, parser)`: missing file, parse throw, or a non-object root all
/// yield `null`.
fn read_object_file<F>(file_path: &str, parser: F) -> Option<Value>
where
    F: FnOnce(&str) -> Option<Value>,
{
    let raw = read_text_file(file_path)?;
    match parser(&raw) {
        Some(value @ Value::Object(_)) => Some(value),
        _ => None,
    }
}

/// The `smol-toml` half of `readObjectFile`.
pub fn read_toml_file(file_path: &str) -> Option<Value> {
    read_object_file(file_path, |raw| {
        toml_to_json(raw)
    })
}

/// The `yaml` half of `readObjectFile`.
pub fn read_yaml_file(file_path: &str) -> Option<Value> {
    read_object_file(file_path, |raw| {
        yaml_to_json(raw)
    })
}

/// TOML text → a JSON value, with the same acceptance rules as the legacy `smol-toml` call:
/// a document whose root is not a table is rejected by the caller.
pub fn toml_to_json(raw: &str) -> Option<Value> {
    toml::from_str::<toml::Value>(raw)
        .ok()
        .map(toml_value_to_json)
}

fn toml_value_to_json(value: toml::Value) -> Value {
    match value {
        toml::Value::String(text) => Value::String(text),
        toml::Value::Integer(number) => Value::from(number),
        toml::Value::Float(number) => Value::from(number),
        toml::Value::Boolean(flag) => Value::Bool(flag),
        toml::Value::Datetime(text) => Value::String(text.to_string()),
        toml::Value::Array(items) => Value::Array(items.into_iter().map(toml_value_to_json).collect()),
        toml::Value::Table(table) => {
            Value::Object(table.into_iter().map(|(key, item)| (key, toml_value_to_json(item))).collect())
        }
    }
}

/// YAML text → a JSON value.
///
/// The legacy `yaml`'s `parse()` throws on a multi-document stream, and a loader that quietly
/// returned the first document would accept a file the legacy code rejected. The same applies
/// to an empty document, whose root is `null`.
pub fn yaml_to_json(raw: &str) -> Option<Value> {
    let documents = yaml_rust2::YamlLoader::load_from_str(raw).ok()?;
    if documents.len() != 1 {
        return None;
    }
    Some(yaml_value_to_json(&documents[0]))
}

fn yaml_value_to_json(value: &yaml_rust2::Yaml) -> Value {
    match value {
        yaml_rust2::Yaml::String(text) => Value::String(text.clone()),
        yaml_rust2::Yaml::Real(text) => serde_json::from_str::<Value>(text)
            .ok()
            .filter(Value::is_number)
            .unwrap_or(Value::Null),
        yaml_rust2::Yaml::Integer(number) => Value::from(*number),
        yaml_rust2::Yaml::Boolean(flag) => Value::Bool(*flag),
        yaml_rust2::Yaml::Array(items) => {
            Value::Array(items.iter().map(yaml_value_to_json).collect())
        }
        yaml_rust2::Yaml::Hash(entries) => Value::Object(
            entries
                .iter()
                .map(|(key, item)| (yaml_key_to_string(key), yaml_value_to_json(item)))
                .collect(),
        ),
        // `Null`, `BadValue`, `Alias` and `Tagged` have no counterpart the detectors read.
        _ => Value::Null,
    }
}

fn yaml_key_to_string(key: &yaml_rust2::Yaml) -> String {
    match key {
        yaml_rust2::Yaml::String(text) => text.clone(),
        yaml_rust2::Yaml::Integer(number) => number.to_string(),
        yaml_rust2::Yaml::Boolean(flag) => flag.to_string(),
        other => format!("{other:?}"),
    }
}

/// `readNestedString`: walk object keys, and require a string at the end.
///
/// Arrays and non-objects abort the walk exactly as the legacy `Array.isArray(current)` guard
/// did, so a list element can never satisfy a dotted path.
pub fn read_nested_string(value: &Value, path_segments: &[&str]) -> Option<String> {
    read_nested_string_in_object(value.as_object()?, path_segments)
}

/// `readNestedString` against an already-unwrapped object, so a caller holding a
/// `serde_json::Map` does not rebuild a `Value` just to walk it.
pub fn read_nested_string_in_object(
    root: &serde_json::Map<String, Value>,
    path_segments: &[&str],
) -> Option<String> {
    let (last, leading) = path_segments.split_last()?;
    let mut current = root;
    for segment in leading {
        current = current.get(*segment)?.as_object()?;
    }
    normalize_font_family(current.get(*last)?.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Option<String> {
        parse_jsonc(raw)?.get("a")?.as_str().map(str::to_owned)
    }

    #[test]
    fn strict_json_takes_the_first_attempt() {
        assert_eq!(parse(r#"{"a":"kept"}"#).as_deref(), Some("kept"));
    }

    #[test]
    fn comments_and_trailing_commas_are_removed() {
        let raw = r#"{
            // a line comment
            "a": "kept", /* and a block
            comment spanning lines */
        }"#;
        assert_eq!(parse(raw).as_deref(), Some("kept"));
    }

    #[test]
    fn comment_markers_inside_strings_survive() {
        let raw = r#"{"a": "http://example.com/* not a comment */"}"#;
        assert_eq!(parse(raw).as_deref(), Some("http://example.com/* not a comment */"));
    }

    #[test]
    fn escaped_quote_does_not_end_the_string() {
        let raw = r#"{"a": "he said \" // not a comment"}"#;
        assert_eq!(parse(raw).as_deref(), Some(r#"he said " // not a comment"#));
    }

    #[test]
    fn malformed_jsonc_yields_no_profile() {
        assert!(parse_jsonc("{ not json at all").is_none());
        assert!(parse_jsonc("").is_none());
        assert!(parse_jsonc("[1, 2]").is_none(), "an array root is not an object");
        assert!(parse_jsonc("\"a string\"").is_none());
    }

    #[test]
    fn an_unterminated_block_comment_swallows_the_rest_of_the_file() {
        // The stripper consumes to EOF and emits nothing for the comment, so whatever came
        // before it still parses. That is the legacy behaviour, and a config file that ends
        // mid-comment is accepted rather than rejected.
        assert_eq!(
            parse(r#"{"a": "x"} /* unterminated"#).as_deref(),
            Some("x")
        );
        // Swallowing a *value* does lose it.
        assert_eq!(parse(r#"{"a": "x" /* unterminated"#), None);
    }

    #[test]
    fn nested_string_walks_objects_only() {
        let value: Value = serde_json::from_str(
            r#"{"font":{"face":"  Fira Code  "},"list":[{"face":"No"}],"n":7,"b":true}"#,
        )
        .unwrap();
        assert_eq!(
            read_nested_string(&value, &["font", "face"]).as_deref(),
            Some("Fira Code")
        );
        // An array aborts the walk exactly like the legacy `Array.isArray` guard.
        assert_eq!(read_nested_string(&value, &["list", "face"]), None);
        // A non-string leaf is not a font family.
        assert_eq!(read_nested_string(&value, &["n"]), None);
        assert_eq!(read_nested_string(&value, &["b"]), None);
        // A blank string normalises to absent.
        assert_eq!(read_nested_string(&value, &["missing"]), None);
    }

    #[test]
    fn missing_config_file_is_not_an_error() {
        assert!(read_jsonc_file("/nonexistent/zcode-terminal-profile/settings.json").is_none());
        assert!(read_toml_file("/nonexistent/zcode-terminal-profile/alacritty.toml").is_none());
        assert!(read_yaml_file("/nonexistent/zcode-terminal-profile/alacritty.yml").is_none());
    }

    #[test]
    fn toml_and_yaml_roots_must_be_tables() {
        // A TOML root is always a table, so the malformed-document case is the one that
        // must be rejected.
        assert!(toml_to_json("[unclosed").is_none());
        assert_eq!(
            read_nested_string(&toml_to_json("[font.normal]\nfamily = \"Iosevka\"").unwrap(), &["font", "normal", "family"]).as_deref(),
            Some("Iosevka")
        );
        assert_eq!(
            read_nested_string(&yaml_to_json("font:\n  normal:\n    family: Berkeley Mono\n").unwrap(), &["font", "normal", "family"]).as_deref(),
            Some("Berkeley Mono")
        );
        // A multi-document stream is what the `yaml` package's `parse()` rejects.
        assert!(yaml_to_json("a: 1\n---\nb: 2\n").is_none());
        // An empty document has a null root, which `readObjectFile` rejects.
        assert!(yaml_to_json("").is_none());
        // A non-string leaf.
        assert_eq!(
            read_nested_string(&yaml_to_json("font:\n  normal:\n    family: 42\n").unwrap(), &["font", "normal", "family"]),
            None
        );
    }
}

