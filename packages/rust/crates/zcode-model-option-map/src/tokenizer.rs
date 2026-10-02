//! Restricted-CEL tokenizer for model option maps.
//!
//! Faithful port of `packages/model-option-map/src/tokenizer.ts`: identical
//! token kinds, offsets, and error messages, because config fixtures and error
//! output are compared against the TS implementation.

use crate::types::RestrictedCelError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    Identifier,
    String,
    Number,
    Operator,
    Punctuation,
    Eof,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub value: String,
    pub offset: usize,
    pub end: usize,
}

const DOUBLE_OPERATORS: [&str; 6] = ["&&", "||", "==", "!=", "<=", ">="];
const SINGLE_OPERATORS: [char; 8] = ['+', '-', '*', '/', '%', '!', '<', '>'];
const PUNCTUATION: [char; 10] = ['{', '}', '[', ']', '(', ')', ',', ':', '?', '.'];

pub fn tokenize(source: &str) -> Result<Vec<Token>, RestrictedCelError> {
    let mut tokens = Vec::new();
    let mut offset = 0usize;
    let chars: Vec<char> = source.chars().collect();
    let byte_at = |index: usize| -> String { chars[index].to_string() };
    while offset < chars.len() {
        let character = chars[offset];
        if character.is_whitespace() {
            offset += 1;
            continue;
        }
        if character == '\'' || character == '"' {
            let token = read_string(&chars, offset, character)?;
            offset = token.end;
            tokens.push(token);
            continue;
        }
        if character.is_ascii_digit() {
            let token = read_number(&chars, offset)?;
            offset = token.end;
            tokens.push(token);
            continue;
        }
        if character.is_ascii_alphabetic() || character == '_' {
            let mut end = offset + 1;
            while end < chars.len() && (chars[end].is_ascii_alphanumeric() || chars[end] == '_') {
                end += 1;
            }
            tokens.push(Token {
                kind: TokenKind::Identifier,
                value: chars[offset..end].iter().collect(),
                offset,
                end,
            });
            offset = end;
            continue;
        }
        let pair: String = chars
            .get(offset..offset + 2)
            .map(|slice| slice.iter().collect())
            .unwrap_or_default();
        if DOUBLE_OPERATORS.contains(&pair.as_str()) {
            tokens.push(Token {
                kind: TokenKind::Operator,
                value: pair,
                offset,
                end: offset + 2,
            });
            offset += 2;
            continue;
        }
        if SINGLE_OPERATORS.contains(&character) {
            tokens.push(Token {
                kind: TokenKind::Operator,
                value: byte_at(offset),
                offset,
                end: offset + 1,
            });
            offset += 1;
            continue;
        }
        if PUNCTUATION.contains(&character) {
            tokens.push(Token {
                kind: TokenKind::Punctuation,
                value: byte_at(offset),
                offset,
                end: offset + 1,
            });
            offset += 1;
            continue;
        }
        return Err(RestrictedCelError::new(
            format!(
                "unsupported token {}",
                serde_json::to_string(&character.to_string()).unwrap_or_default()
            ),
            offset,
        ));
    }
    tokens.push(Token {
        kind: TokenKind::Eof,
        value: String::new(),
        offset: chars.len(),
        end: chars.len(),
    });
    Ok(tokens)
}

fn read_number(chars: &[char], offset: usize) -> Result<Token, RestrictedCelError> {
    let rest: String = chars[offset..].iter().collect();
    // Reference shape: (?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?
    let mut len = 0usize;
    if chars[offset] == '0' {
        len = 1;
    } else if chars[offset].is_ascii_digit() {
        let mut i = offset;
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
        }
        len = i - offset;
    }
    let mut cursor = len;
    if cursor > 0 && offset + cursor < chars.len() && chars[offset + cursor] == '.' {
        let frac_start = cursor + 1;
        let mut i = offset + frac_start;
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
        }
        if i > offset + frac_start {
            len = i - offset;
            cursor = i - offset;
        }
    }
    if cursor > 0
        && offset + cursor < chars.len()
        && (chars[offset + cursor] == 'e' || chars[offset + cursor] == 'E')
    {
        let mut i = offset + cursor + 1;
        if i < chars.len() && (chars[i] == '+' || chars[i] == '-') {
            i += 1;
        }
        let digits_start = i;
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
        }
        if i > digits_start {
            len = i - offset;
        }
    }
    if len == 0 {
        return Err(RestrictedCelError::new(
            "invalid number literal".into(),
            offset,
        ));
    }
    let value = &rest[..len];
    Ok(Token {
        kind: TokenKind::Number,
        value: value.to_string(),
        offset,
        end: offset + len,
    })
}

fn read_string(chars: &[char], offset: usize, quote: char) -> Result<Token, RestrictedCelError> {
    let mut cursor = offset + 1;
    let mut value = String::new();
    while cursor < chars.len() {
        let character = chars[cursor];
        if character == quote {
            return Ok(Token {
                kind: TokenKind::String,
                value,
                offset,
                end: cursor + 1,
            });
        }
        if character == '\n' || character == '\r' {
            return Err(RestrictedCelError::new(
                "unterminated string literal".into(),
                offset,
            ));
        }
        if character != '\\' {
            value.push(character);
            cursor += 1;
            continue;
        }
        let escape_offset = cursor;
        cursor += 1;
        let escaped = match chars.get(cursor) {
            Some(c) => *c,
            None => {
                return Err(RestrictedCelError::new(
                    "unterminated string escape".into(),
                    escape_offset,
                ))
            }
        };
        match escaped {
            '\'' => value.push('\''),
            '"' => value.push('"'),
            '\\' => value.push('\\'),
            'b' => value.push('\u{8}'),
            'f' => value.push('\u{c}'),
            'n' => value.push('\n'),
            'r' => value.push('\r'),
            't' => value.push('\t'),
            'u' => {
                let digits: String = chars
                    .get(cursor + 1..cursor + 5)
                    .map(|s| s.iter().collect())
                    .unwrap_or_default();
                if digits.len() != 4 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err(RestrictedCelError::new(
                        "invalid unicode escape".into(),
                        escape_offset,
                    ));
                }
                let code = u32::from_str_radix(&digits, 16).map_err(|_| {
                    RestrictedCelError::new("invalid unicode escape".into(), escape_offset)
                })?;
                value.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                cursor += 5;
                continue;
            }
            other => {
                return Err(RestrictedCelError::new(
                    format!("unsupported string escape \\{other}"),
                    escape_offset,
                ))
            }
        }
        cursor += 1;
    }
    Err(RestrictedCelError::new(
        "unterminated string literal".into(),
        offset,
    ))
}
