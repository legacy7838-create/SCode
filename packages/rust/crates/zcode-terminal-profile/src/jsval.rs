//! ECMAScript / Node primitive semantics that the ported logic depends on.
//!
//! The TypeScript predecessor leaned on `String.prototype.trim`, `Number.parseFloat`,
//! `Math.round`, `Number.prototype.toFixed` and `Buffer.from(s, "base64")`. Each of those
//! has a behaviour that the closest-looking Rust equivalent does **not** share, and each is
//! reachable from a user-authored config file. See `docs/specs/rust-native-terminal-profile.md`
//! §3.5 for the eight rules; this module is where they are implemented and where their tests
//! live.

/// ECMA-262 `WhiteSpace` ∪ `LineTerminator`: the exact set `String.prototype.trim` strips and
/// the regex `\s` class matches.
///
/// Note what is **absent**: U+0085 (NEL) is Unicode `White_Space` but not ECMA-262
/// `WhiteSpace`, and U+FEFF is ECMA-262 `WhiteSpace` (ZWNBSP) but not Unicode `White_Space`.
/// `char::is_whitespace` gets both of those exactly backwards for our purposes.
pub fn is_js_space(c: char) -> bool {
    matches!(c,
        '\u{0009}'..='\u{000D}'
        | '\u{0020}'
        | '\u{00A0}'
        | '\u{1680}'
        | '\u{2000}'..='\u{200A}'
        | '\u{2028}'
        | '\u{2029}'
        | '\u{202F}'
        | '\u{205F}'
        | '\u{3000}'
        | '\u{FEFF}')
}

/// ECMA-262 `LineTerminator`: what `.` in a JavaScript regex refuses to match, and where
/// `^`/`$` anchor in multiline mode.
pub fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `String.prototype.trim`.
pub fn js_trim(value: &str) -> &str {
    let mut start = 0usize;
    for (index, ch) in value.char_indices() {
        if is_js_space(ch) {
            start = index + ch.len_utf8();
        } else {
            break;
        }
    }
    let mut end = value.len();
    for (index, ch) in value.char_indices().rev() {
        if is_js_space(ch) {
            end = index;
        } else {
            break;
        }
    }
    &value[start..end.max(start)]
}

/// `Number.parseFloat` — the `StrDecimalLiteral` prefix scan, not a full-string parse.
///
/// Divergences from `str::parse::<f64>()` that this exists for: `"12abc"` → `12`,
/// `"0x10"` → `0`, `""` → `NaN`, `"Infinity"` → `Infinity`, `"5."` → `5`.
pub fn js_parse_float(input: &str) -> f64 {
    let bytes = input.as_bytes();
    let mut index = 0usize;
    let negative = match bytes.first() {
        Some(b'-') => {
            index = 1;
            true
        }
        Some(b'+') => {
            index = 1;
            false
        }
        _ => false,
    };

    if input[index..].starts_with("Infinity") {
        return if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }

    let int_start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    let int_len = index - int_start;

    if index < bytes.len() && bytes[index] == b'.' {
        let frac_start = index + 1;
        let mut cursor = frac_start;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
            cursor += 1;
        }
        let frac_len = cursor - frac_start;
        if int_len == 0 && frac_len == 0 {
            // A bare "." is not a DecimalLiteral.
            return f64::NAN;
        }
        index = cursor;
    } else if int_len == 0 {
        return f64::NAN;
    }

    if index < bytes.len() && (bytes[index] == b'e' || bytes[index] == b'E') {
        let mut cursor = index + 1;
        if cursor < bytes.len() && (bytes[cursor] == b'+' || bytes[cursor] == b'-') {
            cursor += 1;
        }
        let digits_start = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
            cursor += 1;
        }
        // An `e` with no digits is not part of the literal.
        if cursor > digits_start {
            index = cursor;
        }
    }

    input[..index].parse::<f64>().unwrap_or(f64::NAN)
}

/// `Math.round`.
///
/// Ties go toward `+∞`, not away from zero, and the two half-unit special cases come
/// **before** the addition: `Math.round(0.49999999999999994)` is `0` even though
/// `0.49999999999999994 + 0.5` rounds up to exactly `1.0` in IEEE-754, because the spec
/// short-circuits on "x < 0.5 and x >= 0" first.
pub fn js_round(value: f64) -> f64 {
    if value.is_nan() || value.is_infinite() || value == 0.0 {
        return value;
    }
    if (0.0..0.5).contains(&value) {
        return 0.0;
    }
    if (-0.5..0.0).contains(&value) {
        return -0.0;
    }
    (value + 0.5).floor()
}

/// `Number.prototype.toFixed(3)` followed by unary `+` and template interpolation, which is
/// what `normalizeMacOsColor` does for a translucent colour.
///
/// The round trip matters: `toFixed(3)` of `0.5` is `"0.500"`, `+"0.500"` is `0.5`, and
/// `` `${0.5}` `` is `"0.5"`. So the emitted string is `rgba(0, 0, 0, 0.5)`, never
/// `rgba(0, 0, 0, 0.500)`.
///
/// Rounding is done on the **exact** binary value, not on its shortest decimal
/// representation: `0.1235` is stored as `0.12349999999999999866…`, so ECMAScript picks
/// `n = 123`, and rounding the repr `"0.1235"` half-up would have picked `124`.
pub fn format_fixed_stripped(value: f64, digits: u32) -> String {
    debug_assert!(value.is_finite());
    let negative = value.is_sign_negative();
    let scale = 10u128.pow(digits);
    let scaled = round_half_up_to_integer(value.abs(), digits);
    let mut text = format!(
        "{}.{:0width$}",
        scaled / scale,
        scaled % scale,
        width = digits as usize
    );
    if digits > 0 {
        while text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.pop();
        }
    }
    if negative {
        format!("-{text}")
    } else {
        text
    }
}

/// `value * 10^digits`, rounded to the nearest integer with ties going to the larger integer
/// (the ECMAScript `toFixed` rule: "if there are two such n, pick the larger n").
///
/// Exact: the f64 is decomposed into `mantissa * 2^exp` and the whole comparison is done in
/// integers, so no intermediate `value * 1000.0` rounding error can change the result.
fn round_half_up_to_integer(value: f64, digits: u32) -> u128 {
    let (mantissa, exponent) = decompose(value);
    let numerator = mantissa * 10u128.pow(digits);
    if exponent >= 0 {
        return numerator << (exponent as u32).min(64);
    }
    let shift = (-exponent) as u32;
    if shift >= 128 {
        // |value| is so small that `value * 10^digits` is strictly below 0.5.
        return 0;
    }
    let denominator = 1u128 << shift;
    let floor = numerator / denominator;
    let remainder = numerator % denominator;
    // Compare remainder/denominator against 1/2 without overflowing: 2*remainder vs denominator.
    if remainder.checked_mul(2).is_some_and(|doubled| doubled >= denominator) {
        floor + 1
    } else {
        floor
    }
}

/// Exact decomposition of a finite, non-negative f64 into `mantissa * 2^exponent`.
fn decompose(value: f64) -> (u128, i32) {
    let bits = value.to_bits();
    let raw_exponent = ((bits >> 52) & 0x7ff) as i32;
    let raw_mantissa = bits & 0x000f_ffff_ffff_ffff;
    if raw_exponent == 0 {
        // Subnormal: value = mantissa * 2^-1074.
        (raw_mantissa as u128, -1074)
    } else {
        let mantissa = (1u128 << 52) | raw_mantissa as u128;
        (mantissa, raw_exponent - 1023 - 52)
    }
}

/// `Buffer.from(value, "base64").toString("latin1")` — Node's lenient decoder.
///
/// Every character outside the base64 alphabet is skipped rather than rejected, `=` terminates
/// the input, and a trailing group of two or three characters still decodes. A strict decoder
/// would produce a different byte string for the archived-font blobs in a Terminal plist.
pub fn node_base64_decode(value: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(value.len() / 4 * 3 + 3);
    let mut accumulator: u32 = 0;
    let mut bits: u32 = 0;
    for byte in value.as_bytes() {
        if *byte == b'=' {
            break;
        }
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => continue,
        } as u32;
        accumulator = (accumulator << 6) | sextet;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    out
}

/// Character class `[A-Za-z0-9 ._-]` of the archived-font-name regex.
pub fn is_font_class_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b' ' | b'.' | b'_' | b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_trim_matches_ecma_not_unicode_white_space() {
        assert_eq!(js_trim("  Menlo  "), "Menlo");
        assert_eq!(js_trim("\t\nMenlo\r\n"), "Menlo");
        // U+FEFF is ECMA-262 WhiteSpace (ZWNBSP): trimmed.
        assert_eq!(js_trim("\u{FEFF}Menlo\u{FEFF}"), "Menlo");
        // U+0085 is Unicode White_Space but NOT ECMA-262 WhiteSpace: kept.
        assert_eq!(js_trim("\u{0085}Menlo\u{0085}"), "\u{0085}Menlo\u{0085}");
        // U+00A0 (NBSP) and U+3000 are in both.
        assert_eq!(js_trim("\u{00A0}Menlo\u{3000}"), "Menlo");
        assert_eq!(js_trim("   "), "");
        assert_eq!(js_trim(""), "");
    }

    #[test]
    fn js_parse_float_takes_the_longest_valid_prefix() {
        assert_eq!(js_parse_float("12abc"), 12.0);
        assert_eq!(js_parse_float("0x10"), 0.0);
        assert!(js_parse_float("").is_nan());
        assert!(js_parse_float("e3").is_nan());
        assert!(js_parse_float(".e3").is_nan());
        assert_eq!(js_parse_float("0.5"), 0.5);
        assert_eq!(js_parse_float(".5"), 0.5);
        assert_eq!(js_parse_float("5."), 5.0);
        assert_eq!(js_parse_float("-3.5"), -3.5);
        assert_eq!(js_parse_float("+7"), 7.0);
        assert_eq!(js_parse_float("1e3"), 1000.0);
        assert_eq!(js_parse_float("1e"), 1.0);
        assert_eq!(js_parse_float("Infinity"), f64::INFINITY);
        assert_eq!(js_parse_float("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(js_parse_float("Infinityxyz"), f64::INFINITY);
        assert!(js_parse_float("Infinity").is_infinite());
        assert!(js_parse_float(".").is_nan());
    }

    #[test]
    fn js_round_breaks_ties_upward() {
        assert_eq!(js_round(0.5), 1.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(0.499_999_999_999_999_94), 0.0);
        assert_eq!(js_round(0.0), 0.0);
    }

    #[test]
    fn to_fixed_round_trip_strips_trailing_zeros() {
        assert_eq!(format_fixed_stripped(0.5, 3), "0.5");
        assert_eq!(format_fixed_stripped(0.0, 3), "0");
        assert_eq!(format_fixed_stripped(0.05, 3), "0.05");
        assert_eq!(format_fixed_stripped(0.999, 3), "0.999");
        assert_eq!(format_fixed_stripped(0.25, 3), "0.25");
        // ECMAScript: n is chosen to minimise |n/1000 - x|, ties pick the larger n.
        assert_eq!(format_fixed_stripped(0.0625, 3), "0.063");
        // The exact binary value of 0.1235 is below 0.1235, so it rounds down.
        assert_eq!(format_fixed_stripped(0.1235, 3), "0.123");
        assert_eq!(format_fixed_stripped(0.000_5, 3), "0.001");
    }

    #[test]
    fn node_base64_is_lenient() {
        assert_eq!(node_base64_decode("aGk="), b"hi".to_vec());
        assert_eq!(node_base64_decode("aGk"), b"hi".to_vec());
        assert_eq!(node_base64_decode("a G\nk"), b"hi".to_vec());
        assert_eq!(node_base64_decode("aGk=x"), b"hi".to_vec());
        assert_eq!(node_base64_decode(""), Vec::<u8>::new());
    }
}
