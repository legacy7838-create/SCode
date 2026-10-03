//! Loose frontmatter parsing, ported from the TypeScript original.
//!
//! Source of truth: `apps/zcode-cli/packages/core/src/subagent/profile-frontmatter.ts`.
//! Every rule below is a direct port of one rule there, including the ones that look
//! like defects — the goal is behaviour identity, not improvement. Where a rule is odd,
//! the comment says what it mirrors so a future reader does not "fix" it.
//!
//! This is deliberately NOT a YAML parser. The original is a hand-rolled loose reader
//! (spec `docs/specs/rust-native-server.md`), and swapping in a real YAML parser would
//! silently change which agent files load.

/// A parsed frontmatter value. `serde_json::Value` is used rather than an enum so the
/// JSON produced for the napi boundary matches the TypeScript object's shape exactly,
/// including key order (the workspace enables `preserve_order` for this reason).
pub type FrontmatterValues = serde_json::Map<String, serde_json::Value>;

pub(crate) struct LooseFrontmatter {
    pub values: FrontmatterValues,
    /// Keys written as `key:` with nothing after them.
    pub bare_value_keys: Vec<String>,
    /// Keys whose block contained a nested mapping rather than a flat list.
    pub invalid_nested_list_keys: Vec<String>,
}

/// Split `---\n…\n---` frontmatter off the body.
///
/// Mirrors `splitMarkdownFrontmatter`: a BOM is stripped, the opening line must be
/// exactly `---` after trimming, and the closing fence is the next line that trims to
/// `---`.
pub fn split_markdown_frontmatter(content: &str) -> (Option<String>, String) {
    let normalized = content.strip_prefix('\u{feff}').unwrap_or(content);
    if !normalized.starts_with("---") {
        return (None, normalized.to_string());
    }
    let lines: Vec<&str> = normalized.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return (None, normalized.to_string());
    }
    let end_index = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, line)| line.trim() == "---")
        .map(|(index, _)| index);
    let Some(end_index) = end_index else {
        return (None, normalized.to_string());
    };
    let frontmatter = lines[1..end_index].join("\n");
    let body = lines[end_index + 1..].join("\n");
    (Some(frontmatter), body)
}

/// Port of `parseLooseFrontmatter`.
pub(crate) fn parse_loose_frontmatter(frontmatter: &str) -> LooseFrontmatter {
    let mut bare_value_keys: Vec<String> = Vec::new();
    let mut invalid_nested_list_keys: Vec<String> = Vec::new();
    let mut values = FrontmatterValues::new();
    let mut pending_list_key: Option<String> = None;

    for raw_line in frontmatter.split('\n') {
        let line = raw_line.trim_end_matches('\r').trim_end();
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }

        // `  - item` continues the pending key as a list.
        if let Some(item) = match_list_line(line) {
            if let Some(key) = pending_list_key.as_ref() {
                bare_value_keys.retain(|k| k != key);
                if key == "mcpServers" && is_unquoted_mapping_value(item) {
                    push_unique(&mut invalid_nested_list_keys, key);
                }
                let mut existing: Vec<serde_json::Value> = match values.get(key) {
                    Some(serde_json::Value::Array(items)) => items.clone(),
                    _ => Vec::new(),
                };
                existing.push(if key == "mcpServers" {
                    parse_mcp_server_list_item(item)
                } else {
                    parse_scalar_value(item, false)
                });
                values.insert(key.clone(), serde_json::Value::Array(existing));
                continue;
            }
        }

        // A deeper-indented line under a pending key is a block mapping, which this
        // reader cannot express. It is recorded as invalid rather than swallowed, so
        // `mcpServers` does not silently become an empty list.
        if pending_list_key.is_some() && raw_line.starts_with([' ', '\t']) {
            push_unique(&mut invalid_nested_list_keys, pending_list_key.as_ref().unwrap());
            pending_list_key = None;
            continue;
        }

        pending_list_key = None;
        let Some((key, raw_value)) = match_key_value(line) else {
            continue;
        };
        if raw_value.trim().is_empty() {
            values.insert(key.clone(), serde_json::Value::Array(Vec::new()));
            push_unique(&mut bare_value_keys, &key);
            pending_list_key = Some(key);
            continue;
        }
        if key == "mcpServers" && has_unquoted_inline_mapping_item(raw_value) {
            push_unique(&mut invalid_nested_list_keys, &key);
        }
        let parsed = parse_scalar_value(raw_value, key == "mcpServers");
        values.insert(key, parsed);
    }

    LooseFrontmatter {
        values,
        bare_value_keys,
        invalid_nested_list_keys,
    }
}

/// Port of the list-line regex `/^\s*-\s+(.*)$/u`.
fn match_list_line(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix('-')?;
    let rest = rest.trim_start_matches([' ', '\t']);
    // `\s+` requires at least one space, so a bare `-` is not a list item.
    if rest.len() == trimmed.len() - 1 {
        return None;
    }
    Some(rest)
}

/// Port of `/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/u`.
fn match_key_value(line: &str) -> Option<(String, &str)> {
    let bytes = line.as_bytes();
    let mut index = 0usize;
    if index >= bytes.len() || !bytes[index].is_ascii_alphabetic() {
        return None;
    }
    index += 1;
    while index < bytes.len()
        && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_' || bytes[index] == b'-')
    {
        index += 1;
    }
    // `\s*:` — the colon must follow the name, with optional whitespace between.
    let mut cursor = index;
    while cursor < bytes.len() && (bytes[cursor] as char).is_whitespace() {
        cursor += 1;
    }
    if cursor >= bytes.len() || bytes[cursor] != b':' {
        return None;
    }
    cursor += 1;
    while cursor < bytes.len() && (bytes[cursor] as char).is_whitespace() {
        cursor += 1;
    }
    let key = line[..index].to_string();
    let value = &line[cursor..];
    // A key must be followed by `:` and content on the SAME line; the leading part is
    // anchored, so a line like `foo bar: baz` never matches.
    Some((key, value))
}

/// Port of `stripInlineComment`: a `#` that follows whitespace and is outside quotes.
pub(crate) fn strip_inline_comment(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut quote: Option<char> = None;
    for (index, &c) in chars.iter().enumerate() {
        if (c == '"' || c == '\'') && (index == 0 || chars[index - 1] != '\\') {
            quote = if quote == Some(c) { None } else { quote.or(Some(c)) };
        }
        let preceded_by_space = index > 0 && chars[index - 1].is_whitespace();
        if quote.is_none() && c == '#' && preceded_by_space {
            return chars[..index].iter().collect::<String>().trim_end().to_string();
        }
    }
    value.to_string()
}

/// Port of `unquoteScalar`.
pub(crate) fn unquote_scalar(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0] as char;
        let last = bytes[bytes.len() - 1] as char;
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

/// Port of `parseScalarValue`.
pub(crate) fn parse_scalar_value(raw_value: &str, parse_inline_item_scalars: bool) -> serde_json::Value {
    let value = strip_inline_comment(raw_value.trim());
    if value == "true" {
        return serde_json::Value::Bool(true);
    }
    if value == "false" {
        return serde_json::Value::Bool(false);
    }
    if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) {
        if let Ok(parsed) = value.parse::<i64>() {
            return serde_json::Value::from(parsed);
        }
    }
    if value.starts_with('[') && value.ends_with(']') && value.len() >= 2 {
        let inner = &value[1..value.len() - 1];
        let items = split_top_level_list(inner, parse_inline_item_scalars);
        let mapped: Vec<serde_json::Value> = items
            .iter()
            .map(|item| {
                if parse_inline_item_scalars {
                    parse_mcp_server_list_item(item)
                } else {
                    serde_json::Value::String(unquote_scalar(strip_inline_comment(item.trim()).as_str()))
                }
            })
            .collect();
        return serde_json::Value::Array(mapped);
    }
    if value.starts_with('{') && value.ends_with('}') && value.len() >= 2 {
        // A `{…}` value is JSON-parsed. On failure the original returns the raw text,
        // and the yield contract then rejects it as a non-object — deliberately loud.
        return match serde_json::from_str::<serde_json::Value>(&value) {
            Ok(parsed) => parsed,
            Err(_) => serde_json::Value::String(value),
        };
    }
    serde_json::Value::String(unquote_scalar(&value))
}

/// Port of `parseMcpServerListItem`.
fn parse_mcp_server_list_item(raw_value: &str) -> serde_json::Value {
    let value = strip_inline_comment(raw_value.trim());
    let bytes = value.as_bytes();
    if value.len() >= 2 {
        let first = bytes[0] as char;
        let last = bytes[bytes.len() - 1] as char;
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return serde_json::Value::String(unquote_scalar(&value));
        }
    }
    if value.starts_with('[') && value.ends_with(']') {
        return serde_json::Value::Null;
    }
    if value.eq_ignore_ascii_case("null") || value == "~" {
        return serde_json::Value::Null;
    }
    if value.eq_ignore_ascii_case("true") {
        return serde_json::Value::Bool(true);
    }
    if value.eq_ignore_ascii_case("false") {
        return serde_json::Value::Bool(false);
    }
    if is_number_literal(&value) {
        if let Ok(parsed) = value.parse::<f64>() {
            return serde_json::Number::from_f64(parsed)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null);
        }
    }
    serde_json::Value::String(value)
}

/// Port of `/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu`.
fn is_number_literal(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0usize;
    if index < bytes.len() && (bytes[index] == b'+' || bytes[index] == b'-') {
        index += 1;
    }
    let digits_start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    let mut saw_digit = index > digits_start;
    if index < bytes.len() && bytes[index] == b'.' {
        index += 1;
        let frac_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        saw_digit = saw_digit || index > frac_start;
    }
    if !saw_digit {
        return false;
    }
    if index < bytes.len() && (bytes[index] == b'e' || bytes[index] == b'E') {
        index += 1;
        if index < bytes.len() && (bytes[index] == b'+' || bytes[index] == b'-') {
            index += 1;
        }
        let exp_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == exp_start {
            return false;
        }
    }
    index == bytes.len()
}

/// Port of `isUnquotedMappingValue`.
fn is_unquoted_mapping_value(raw_value: &str) -> bool {
    let value = strip_inline_comment(raw_value.trim());
    let bytes = value.as_bytes();
    if value.len() >= 2 {
        let first = bytes[0] as char;
        let last = bytes[bytes.len() - 1] as char;
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return false;
        }
    }
    if value.len() >= 2 && value.starts_with('{') && value.ends_with('}') {
        return true;
    }
    // `/^[^:]+:(?:\s|$)/u` — a colon then end-of-string or whitespace.
    if let Some(colon) = value.find(':') {
        if !value[..colon].is_empty() {
            let after = &value[colon + 1..];
            return after.is_empty() || after.starts_with([' ', '\t']);
        }
    }
    false
}

/// Port of `hasUnquotedInlineMappingItem`.
fn has_unquoted_inline_mapping_item(raw_value: &str) -> bool {
    let value = strip_inline_comment(raw_value.trim());
    if !(value.starts_with('[') && value.ends_with(']')) {
        return false;
    }
    split_top_level_list(&value[1..value.len() - 1], true)
        .iter()
        .any(|item| is_unquoted_mapping_value(item))
}

/// Port of `splitTopLevelList`: splits on commas that are not inside quotes, braces or
/// brackets. `track_container_depth` corresponds to the TypeScript default `false`.
fn split_top_level_list(value: &str, track_container_depth: bool) -> Vec<String> {
    let mut items: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut brace_depth = 0i32;
    let mut bracket_depth = 0i32;

    for c in value.chars() {
        if let Some(open) = quote {
            current.push(c);
            if c == open {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => {
                quote = Some(c);
                current.push(c);
            }
            '{' if track_container_depth => {
                brace_depth += 1;
                current.push(c);
            }
            '}' if track_container_depth => {
                brace_depth -= 1;
                current.push(c);
            }
            '[' if track_container_depth => {
                bracket_depth += 1;
                current.push(c);
            }
            ']' if track_container_depth => {
                bracket_depth -= 1;
                current.push(c);
            }
            ',' if brace_depth == 0 && bracket_depth == 0 => {
                items.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    items.push(current);
    items
}

fn push_unique(target: &mut Vec<String>, value: &str) {
    if !target.iter().any(|item| item == value) {
        target.push(value.to_string());
    }
}
