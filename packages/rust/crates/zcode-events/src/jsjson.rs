//! JSON with JavaScript semantics over UTF-16 code units.
//!
//! Used for the copy-legacy merge (`saveMessage`/`savePart` with `copyFrom`)
//! and for re-encoding JSON columns that legacy code round-trips through
//! `JSON.parse` + `JSON.stringify`. Strings are `Vec<u16>` so lone surrogates
//! (valid JSON escapes, invalid UTF-8) survive round-trips exactly like V8.
//!
//! `stringify` implements ECMA-262 `JSON.stringify` on the value level:
//! minimal escaping (the five named escapes, `\u00XX` for other C0 controls,
//! well-formed `\uXXXX` for lone surrogates), JS `Number::toString` digits,
//! `null` for non-finite numbers, object key order = insertion order.

use crate::error::StoreError;

#[derive(Debug, Clone, PartialEq)]
pub enum JsValue {
  Null,
  Bool(bool),
  Number(f64),
  Str(Vec<u16>),
  Arr(Vec<JsValue>),
  Obj(Vec<(Vec<u16>, JsValue)>),
}

impl JsValue {
  pub fn as_str(&self) -> Option<String> {
    match self {
      JsValue::Str(s) => Some(units_to_string(s)),
      _ => None,
    }
  }

  pub fn as_f64(&self) -> Option<f64> {
    match self {
      JsValue::Number(n) => Some(*n),
      _ => None,
    }
  }

  pub fn as_i64(&self) -> Option<i64> {
    match self {
      JsValue::Number(n) if n.fract() == 0.0 && n.is_finite() => Some(*n as i64),
      _ => None,
    }
  }

  pub fn as_bool(&self) -> Option<bool> {
    match self {
      JsValue::Bool(b) => Some(*b),
      _ => None,
    }
  }

  pub fn as_array(&self) -> Option<&Vec<JsValue>> {
    match self {
      JsValue::Arr(a) => Some(a),
      _ => None,
    }
  }

  pub fn as_object(&self) -> Option<&Vec<(Vec<u16>, JsValue)>> {
    match self {
      JsValue::Obj(o) => Some(o),
      _ => None,
    }
  }

  pub fn is_null(&self) -> bool {
    matches!(self, JsValue::Null)
  }

  pub fn get(&self, key: &str) -> Option<&JsValue> {
    let obj = self.as_object()?;
    let key_units: Vec<u16> = key.encode_utf16().collect();
    obj.iter().find(|(k, _)| *k == key_units).map(|(_, v)| v)
  }

  pub fn has_key(&self, key: &str) -> bool {
    self.get(key).is_some()
  }

  pub fn type_of(&self) -> &'static str {
    match self {
      JsValue::Null => "null",
      JsValue::Bool(_) => "boolean",
      JsValue::Number(_) => "number",
      JsValue::Str(_) => "string",
      JsValue::Arr(_) => "array",
      JsValue::Obj(_) => "object",
    }
  }
}

pub fn units_to_string(units: &[u16]) -> String {
  String::from_utf16_lossy(units)
}

fn js_err(message: impl Into<String>) -> StoreError {
  StoreError::op(format!("JSON: {}", message.into()))
}

// ── parser ───────────────────────────────────────────────────────────────────

pub fn parse(text: &str) -> Result<JsValue, StoreError> {
  let bytes = text.as_bytes();
  let mut pos = 0usize;
  let value = parse_value(bytes, &mut pos, 0)?;
  skip_ws(bytes, &mut pos);
  if pos != bytes.len() {
    return Err(js_err("unexpected trailing characters"));
  }
  Ok(value)
}

const MAX_DEPTH: u32 = 512;

fn skip_ws(bytes: &[u8], pos: &mut usize) {
  while *pos < bytes.len() && matches!(bytes[*pos], b' ' | b'\t' | b'\n' | b'\r') {
    *pos += 1;
  }
}

fn parse_value(bytes: &[u8], pos: &mut usize, depth: u32) -> Result<JsValue, StoreError> {
  if depth > MAX_DEPTH {
    return Err(js_err("maximum nesting depth exceeded"));
  }
  skip_ws(bytes, pos);
  if *pos >= bytes.len() {
    return Err(js_err("unexpected end of input"));
  }
  match bytes[*pos] {
    b'n' => {
      expect_literal(bytes, pos, b"null")?;
      Ok(JsValue::Null)
    }
    b't' => {
      expect_literal(bytes, pos, b"true")?;
      Ok(JsValue::Bool(true))
    }
    b'f' => {
      expect_literal(bytes, pos, b"false")?;
      Ok(JsValue::Bool(false))
    }
    b'"' => parse_string(bytes, pos).map(JsValue::Str),
    b'[' => parse_array(bytes, pos, depth),
    b'{' => parse_object(bytes, pos, depth),
    b'-' | b'0'..=b'9' => parse_number(bytes, pos),
    other => Err(js_err(format!("unexpected character {:?}", other as char))),
  }
}

fn expect_literal(bytes: &[u8], pos: &mut usize, literal: &[u8]) -> Result<(), StoreError> {
  if bytes.len() - *pos < literal.len() || &bytes[*pos..*pos + literal.len()] != literal {
    return Err(js_err("invalid literal"));
  }
  *pos += literal.len();
  Ok(())
}

fn parse_number(bytes: &[u8], pos: &mut usize) -> Result<JsValue, StoreError> {
  let start = *pos;
  if *pos < bytes.len() && bytes[*pos] == b'-' {
    *pos += 1;
  }
  let int_start = *pos;
  while *pos < bytes.len() && bytes[*pos].is_ascii_digit() {
    *pos += 1;
  }
  if *pos == int_start {
    return Err(js_err("invalid number"));
  }
  // No leading zeros (except a single `0`).
  if bytes[int_start] == b'0' && *pos > int_start + 1 {
    return Err(js_err("invalid number: leading zero"));
  }
  if *pos < bytes.len() && bytes[*pos] == b'.' {
    *pos += 1;
    let frac_start = *pos;
    while *pos < bytes.len() && bytes[*pos].is_ascii_digit() {
      *pos += 1;
    }
    if *pos == frac_start {
      return Err(js_err("invalid number: missing fraction digits"));
    }
  }
  if *pos < bytes.len() && matches!(bytes[*pos], b'e' | b'E') {
    *pos += 1;
    if *pos < bytes.len() && matches!(bytes[*pos], b'+' | b'-') {
      *pos += 1;
    }
    let exp_start = *pos;
    while *pos < bytes.len() && bytes[*pos].is_ascii_digit() {
      *pos += 1;
    }
    if *pos == exp_start {
      return Err(js_err("invalid number: missing exponent digits"));
    }
  }
  let text = std::str::from_utf8(&bytes[start..*pos]).map_err(|_| js_err("invalid number"))?;
  // JS `Number(string)` and Rust `f64::from_str` agree on JSON numerals (correctly rounded).
  let value: f64 = text.parse().map_err(|_| js_err("invalid number"))?;
  Ok(JsValue::Number(value))
}

fn parse_string(bytes: &[u8], pos: &mut usize) -> Result<Vec<u16>, StoreError> {
  debug_assert_eq!(bytes[*pos], b'"');
  *pos += 1;
  let mut units: Vec<u16> = Vec::new();
  loop {
    if *pos >= bytes.len() {
      return Err(js_err("unterminated string"));
    }
    let byte = bytes[*pos];
    match byte {
      b'"' => {
        *pos += 1;
        return Ok(units);
      }
      b'\\' => {
        *pos += 1;
        if *pos >= bytes.len() {
          return Err(js_err("unterminated escape"));
        }
        let escape = bytes[*pos];
        *pos += 1;
        match escape {
          b'"' => units.push(b'"' as u16),
          b'\\' => units.push(b'\\' as u16),
          b'/' => units.push(b'/' as u16),
          b'b' => units.push(0x08),
          b'f' => units.push(0x0c),
          b'n' => units.push(0x0a),
          b'r' => units.push(0x0d),
          b't' => units.push(0x09),
          b'u' => {
            let hi = parse_hex4(bytes, pos)?;
            units.push(hi);
            // Keep surrogate escapes as-is (lone surrogates are legal here);
            // a valid pair stays two units and re-encodes to the same bytes.
          }
          other => return Err(js_err(format!("invalid escape {:?}", other as char))),
        }
      }
      0x00..=0x1f => return Err(js_err("unescaped control character in string")),
      _ => {
        // Decode one UTF-8 scalar value into UTF-16 units (lossless; input is a &str).
        let rest = std::str::from_utf8(&bytes[*pos..]).map_err(|_| js_err("invalid UTF-8"))?;
        let ch = rest.chars().next().ok_or_else(|| js_err("invalid UTF-8"))?;
        let mut buf = [0u16; 2];
        units.extend_from_slice(ch.encode_utf16(&mut buf));
        *pos += ch.len_utf8();
      }
    }
  }
}

fn parse_hex4(bytes: &[u8], pos: &mut usize) -> Result<u16, StoreError> {
  if bytes.len() - *pos < 4 {
    return Err(js_err("invalid \\u escape"));
  }
  let mut value: u16 = 0;
  for _ in 0..4 {
    let digit = match bytes[*pos] {
      d @ b'0'..=b'9' => d - b'0',
      d @ b'a'..=b'f' => d - b'a' + 10,
      d @ b'A'..=b'F' => d - b'A' + 10,
      _ => return Err(js_err("invalid \\u escape")),
    };
    value = value * 16 + digit as u16;
    *pos += 1;
  }
  Ok(value)
}

fn parse_array(bytes: &[u8], pos: &mut usize, depth: u32) -> Result<JsValue, StoreError> {
  *pos += 1; // '['
  let mut items = Vec::new();
  skip_ws(bytes, pos);
  if *pos < bytes.len() && bytes[*pos] == b']' {
    *pos += 1;
    return Ok(JsValue::Arr(items));
  }
  loop {
    items.push(parse_value(bytes, pos, depth + 1)?);
    skip_ws(bytes, pos);
    if *pos >= bytes.len() {
      return Err(js_err("unterminated array"));
    }
    match bytes[*pos] {
      b',' => *pos += 1,
      b']' => {
        *pos += 1;
        return Ok(JsValue::Arr(items));
      }
      _ => return Err(js_err("expected ',' or ']' in array")),
    }
  }
}

fn parse_object(bytes: &[u8], pos: &mut usize, depth: u32) -> Result<JsValue, StoreError> {
  *pos += 1; // '{'
  let mut entries: Vec<(Vec<u16>, JsValue)> = Vec::new();
  skip_ws(bytes, pos);
  if *pos < bytes.len() && bytes[*pos] == b'}' {
    *pos += 1;
    return Ok(JsValue::Obj(entries));
  }
  loop {
    skip_ws(bytes, pos);
    if *pos >= bytes.len() || bytes[*pos] != b'"' {
      return Err(js_err("expected string key in object"));
    }
    let key = parse_string(bytes, pos)?;
    skip_ws(bytes, pos);
    if *pos >= bytes.len() || bytes[*pos] != b':' {
      return Err(js_err("expected ':' in object"));
    }
    *pos += 1;
    let value = parse_value(bytes, pos, depth + 1)?;
    // JS objects keep first insertion position for duplicate keys (JSON.parse
    // overwrites the value in place); mirror that.
    if let Some(slot) = entries.iter_mut().find(|(k, _)| *k == key) {
      slot.1 = value;
    } else {
      entries.push((key, value));
    }
    skip_ws(bytes, pos);
    if *pos >= bytes.len() {
      return Err(js_err("unterminated object"));
    }
    match bytes[*pos] {
      b',' => *pos += 1,
      b'}' => {
        *pos += 1;
        return Ok(JsValue::Obj(entries));
      }
      _ => return Err(js_err("expected ',' or '}' in object")),
    }
  }
}

// ── stringify ────────────────────────────────────────────────────────────────

pub fn stringify(value: &JsValue) -> String {
  let mut out = String::new();
  write_value(&mut out, value);
  out
}

fn write_value(out: &mut String, value: &JsValue) {
  match value {
    JsValue::Null => out.push_str("null"),
    JsValue::Bool(true) => out.push_str("true"),
    JsValue::Bool(false) => out.push_str("false"),
    JsValue::Number(n) => {
      if n.is_finite() {
        out.push_str(&js_number_to_string(*n));
      } else {
        // JSON.stringify maps NaN/±Infinity to null.
        out.push_str("null");
      }
    }
    JsValue::Str(units) => write_string(out, units),
    JsValue::Arr(items) => {
      out.push('[');
      for (i, item) in items.iter().enumerate() {
        if i > 0 {
          out.push(',');
        }
        write_value(out, item);
      }
      out.push(']');
    }
    JsValue::Obj(entries) => {
      out.push('{');
      for (i, (key, item)) in entries.iter().enumerate() {
        if i > 0 {
          out.push(',');
        }
        write_string(out, key);
        out.push(':');
        write_value(out, item);
      }
      out.push('}');
    }
  }
}

fn write_string(out: &mut String, units: &[u16]) {
  out.push('"');
  let mut i = 0;
  while i < units.len() {
    let unit = units[i];
    match unit {
      0x22 => out.push_str("\\\""),
      0x5c => out.push_str("\\\\"),
      0x08 => out.push_str("\\b"),
      0x0c => out.push_str("\\f"),
      0x0a => out.push_str("\\n"),
      0x0d => out.push_str("\\r"),
      0x09 => out.push_str("\\t"),
      0x00..=0x1f => out.push_str(&format!("\\u{:04x}", unit)),
      0xd800..=0xdbff => {
        // High surrogate: emit raw when it forms a valid pair (encodes to the
        // identical UTF-8 bytes), else escape (well-formed JSON.stringify).
        let next = units.get(i + 1).copied();
        if let Some(low) = next {
          if (0xdc00..=0xdfff).contains(&low) {
            if let Ok(text) = String::from_utf16(&[unit, low]) {
              out.push_str(&text);
              i += 2;
              continue;
            }
          }
        }
        out.push_str(&format!("\\u{:04x}", unit));
      }
      0xdc00..=0xdfff => {
        out.push_str(&format!("\\u{:04x}", unit));
      }
      other => push_utf16_unit(out, other),
    }
    i += 1;
  }
  out.push('"');
}

fn push_utf16_unit(out: &mut String, unit: u16) {
  match char::from_u32(unit as u32) {
    Some(ch) => out.push(ch),
    // Unreachable: this helper is only called for non-surrogate BMP units.
    None => out.push_str(&format!("\\u{:04x}", unit)),
  }
}

/// ECMA-262 Number::toString(x, 10) — the digits `JSON.stringify` produces.
///
/// Shortest round-trip digits come from serde_json's (ryu) formatting, which is
/// then re-framed into the ECMAScript fixed/exponential rules.
pub fn js_number_to_string(x: f64) -> String {
  if x == 0.0 {
    return "0".to_string(); // also covers -0 (JSON.stringify(-0) === "0")
  }
  let negative = x < 0.0;
  let abs = if negative { -x } else { x };
  // Non-finite callers must have been handled by write_value.
  if !abs.is_finite() {
    return "null".to_string();
  }
  let (digits, exp10) = shortest_digits(abs);
  // value = digits × 10^exp10  ⇒  value = 0.s × 10^n with n = exp10 + k.
  let k = digits.len() as i32;
  let n = exp10 + k;
  let mut out = String::new();
  if negative {
    out.push('-');
  }
  if k <= n && n <= 21 {
    out.push_str(&digits);
    for _ in 0..(n - k) {
      out.push('0');
    }
  } else if 0 < n && n <= 21 {
    out.push_str(&digits[..n as usize]);
    out.push('.');
    out.push_str(&digits[n as usize..]);
  } else if -6 < n && n <= 0 {
    out.push_str("0.");
    for _ in 0..(-n) {
      out.push('0');
    }
    out.push_str(&digits);
  } else {
    // Exponential form.
    if k == 1 {
      out.push_str(&digits);
    } else {
      out.push_str(&digits[..1]);
      out.push('.');
      out.push_str(&digits[1..]);
    }
    let exp = n - 1;
    if exp < 0 {
      out.push_str("e-");
    } else {
      out.push_str("e+");
    }
    out.push_str(&exp.unsigned_abs().to_string());
  }
  out
}

/// Shortest round-trip decimal digits and power: `value = digits × 10^exp10`,
/// `digits` has no trailing zeros and starts with a non-zero digit.
fn shortest_digits(value: f64) -> (String, i32) {
  let text = serde_json::to_string(&value).unwrap_or_else(|_| format!("{}", value));
  // Forms: "123.45", "1e21" (ryu may emit exponent form); normalize both.
  let (mantissa, exp_part) = match text.find(['e', 'E']) {
    Some(idx) => (&text[..idx], text[idx + 1..].parse::<i32>().unwrap_or(0)),
    None => (&text[..], 0),
  };
  let (int_part, frac_part) = match mantissa.find('.') {
    Some(idx) => (&mantissa[..idx], &mantissa[idx + 1..]),
    None => (mantissa, ""),
  };
  let mut digits = String::from(int_part.trim_start_matches('-'));
  digits.push_str(frac_part);
  // value = digits × 10^(exp_part − frac_len) ("12.0" → "120" × 10^-1).
  let mut exp10 = exp_part - frac_part.len() as i32;
  // Strip trailing zeros (ryu pads the integer form, e.g. "1.0").
  while digits.len() > 1 && digits.ends_with('0') {
    digits.pop();
    exp10 += 1;
  }
  if digits == "0" {
    // Extremely small subnormals cannot land here (value != 0), but be safe.
    return ("0".to_string(), 0);
  }
  (digits, exp10)
}

// ─ helpers used by ops ────────────────────────────────────────────────────────

/// Merge used by `copyLegacyMembers` (messages.ts): start from `data`, then
/// copy each legacy key present on `original` (existing keys keep position,
/// new keys append in `keys` order) — exactly the JS `{...data, ...}` loop.
pub fn merge_legacy_keys(data: &JsValue, original: &JsValue, keys: &[&str]) -> Result<JsValue, StoreError> {
  let mut entries = match data {
    JsValue::Obj(entries) => entries.clone(),
    JsValue::Null => Vec::new(),
    _ => return Err(js_err(format!("expected object for copy merge, got {}", data.type_of()))),
  };
  let original_obj = match original {
    JsValue::Obj(entries) => entries,
    other => return Err(js_err(format!("expected object for copy source, got {}", other.type_of()))),
  };
  for key in keys {
    let key_units: Vec<u16> = key.encode_utf16().collect();
    let original_value = original_obj.iter().find(|(k, _)| *k == key_units).map(|(_, v)| v);
    if let Some(value) = original_value {
      if let Some(slot) = entries.iter_mut().find(|(k, _)| *k == key_units) {
        slot.1 = value.clone();
      } else {
        entries.push((key_units, value.clone()));
      }
    }
  }
  Ok(JsValue::Obj(entries))
}
