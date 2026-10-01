//! macOS terminal profile parsing — iTerm2 and Terminal.app plists.
//!
//! Ported from `packages/services/src/terminal/terminalProfileMacOs.ts`. **The plist read is
//! not here**: `readMacOsPlistFile` (`terminalProfileMacOs.ts:48-70`) shells out to
//! `plutil`, and invariant 5 forbids a child-process spawn inside a ported feature. The spawn
//! stays in TypeScript and hands its stdout — the plist as JSON — to [`parse_iterm2_plist`]
//! and [`parse_mac_os_terminal_plist`]. Everything downstream of that string is ported.
//! See `docs/specs/rust-native-terminal-profile.md` §2.2.

use serde_json::{Map, Value};

use crate::jsval::{
    format_fixed_stripped, is_js_space, js_parse_float, js_round, js_trim, node_base64_decode,
};
use crate::jsonc::{normalize_font_family, read_nested_string, read_nested_string_in_object};
use crate::types::{TerminalDetectedProfile, TerminalThemeProfile};

/// A shared "absent" value; `plutil` output is user data, so every lookup is fallible.
const NULL: &Value = &Value::Null;


/// `normalizeFontSize` — the 6..72 clamp, with `parseFloat` prefix semantics for strings.
pub fn normalize_font_size(value: &Value) -> Option<f64> {
    let parsed = match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => js_parse_float(js_trim(text)),
        _ => f64::NAN,
    };
    if !parsed.is_finite() || !(6.0..=72.0).contains(&parsed) {
        return None;
    }
    Some(parsed)
}

/// Byte offset of a char index, for slicing after a char-wise scan.
fn byte_offset(chars: &[char], char_index: usize) -> usize {
    chars
        .iter()
        .take(char_index)
        .map(|ch| ch.len_utf8())
        .sum()
}

/// Whether `\d+(\.\d+)?$` matches `chars[start..]` in full.
fn number_spans_to_end(chars: &[char], start: usize) -> bool {
    let mut cursor = start;
    while cursor < chars.len() && chars[cursor].is_ascii_digit() {
        cursor += 1;
    }
    if cursor == start {
      return false;
    }
    let after_integer = cursor;
    if cursor < chars.len() && chars[cursor] == '.' {
        let mut fraction = cursor + 1;
        while fraction < chars.len() && chars[fraction].is_ascii_digit() {
            fraction += 1;
        }
        if fraction > cursor + 1 {
            cursor = fraction;
        } else {
            cursor = after_integer;
        }
    }
    cursor == chars.len()
}

/// Leftmost match of `\s+(\d+(\.\d+)?)$`, returned as the byte offset of the captured digits
/// and the digits themselves.
///
/// Greedy `\s+` backtracks from the longest whitespace run, and every shorter run lands on
/// another whitespace character where `\d+` cannot start — so the first run that works is
/// also the only one, and scanning runs left to right reproduces the leftmost match.
fn trailing_number(text: &str) -> Option<(usize, &str)> {
    let chars: Vec<char> = text.chars().collect();
    for start in 0..chars.len() {
        if !is_js_space(chars[start]) {
            continue;
        }
        let mut run_end = start;
        while run_end < chars.len() && is_js_space(chars[run_end]) {
            run_end += 1;
        }
        if number_spans_to_end(&chars, run_end) {
            let offset = byte_offset(&chars, run_end);
            return Some((offset, text.get(offset..)?));
        }
    }
    None
}

/// `normalizeMacOsFontName`: drop a trailing size, then turn `-` into spaces.
///
/// `"SF Mono-12"` → `"SF Mono 12"` → `"SF Mono"` → `"SF Mono "`, and the second trim is what
/// removes the space the `-` left behind.
pub fn normalize_mac_os_font_name(value: Option<&str>) -> Option<String> {
    let normalized = normalize_font_family(value)?;
    let without_size = match trailing_number(&normalized) {
        Some((start, _)) => normalized[..start].to_owned(),
        None => normalized,
    };
    normalize_font_family(Some(&without_size.replace('-', " ")))
}

/// `value?.toString()` for the shapes a plist can hold.
fn js_value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Number(number) => Some(number.as_f64().unwrap_or(f64::NAN).to_string()),
        // `Array.prototype.toString` joins with ","; `[object Object]` for everything else.
        Value::Array(items) => Some(
            items
                .iter()
                .map(|item| match item {
                    Value::Null => String::new(),
                    other => js_value_to_string(other).unwrap_or_default(),
                })
                .collect::<Vec<_>>()
                .join(","),
        ),
        Value::Object(_) => Some("[object Object]".to_owned()),
    }
}

/// `readMacOsFontDescriptor` — a font name and size from one plist value such as
/// `"SFMono-Regular-12"`.
pub fn read_mac_os_font_descriptor(value: &Value) -> (Option<String>, Option<f64>) {
    let raw = js_value_to_string(value);
    let font_family = normalize_mac_os_font_name(raw.as_deref());
    let font_size = raw
        .as_deref()
        .and_then(trailing_number)
        .and_then(|(_, digits)| normalize_font_size(&Value::String(digits.to_owned())));
    (font_family, font_size)
}

/// The alternatives of the archived-font-name regex, in source order.
const ARCHIVED_FONT_ALTERNATIVES: [&str; 12] = [
    "Mono",
    "Code",
    "Nerd",
    "Powerline",
    "Console",
    "Menlo",
    "Monaco",
    "Courier",
    "Cascadia",
    "Consolas",
    "Hack",
    "Meslo",
];

fn matches_alternative_ascii_case_insensitive(bytes: &[u8], at: usize, alternative: &str) -> bool {
    let candidate = alternative.as_bytes();
    if at + candidate.len() > bytes.len() {
        return false;
    }
    bytes[at..at + candidate.len()]
        .iter()
        .zip(candidate)
        .all(|(byte, expected)| byte.to_ascii_lowercase() == expected.to_ascii_lowercase())
}

/// `/([A-Za-z][A-Za-z0-9 ._-]*(?:Mono|…|Meslo)[A-Za-z0-9 ._-]*)/i`, transcribed.
///
/// Leftmost-first, not longest-match: the engine takes the smallest start that can match, and
/// at that start the greedy `[A-Za-z0-9 ._-]*` tries the **longest** run before backing off, so
/// the alternative is sought from the end of the class run backwards. The captured span then
/// extends greedily again over the trailing class run.
fn find_archived_font_name(decoded: &[u8]) -> Option<String> {
    for start in 0..decoded.len() {
        if !decoded[start].is_ascii_alphabetic() {
            continue;
        }
        let mut run_end = start + 1;
        while run_end < decoded.len() && crate::jsval::is_font_class_byte(decoded[run_end]) {
            run_end += 1;
        }
        let mut cursor = run_end;
        while cursor > start {
            for alternative in ARCHIVED_FONT_ALTERNATIVES {
                if matches_alternative_ascii_case_insensitive(decoded, cursor, alternative) {
                    let mut end = cursor + alternative.len();
                    while end < decoded.len() && crate::jsval::is_font_class_byte(decoded[end]) {
                        end += 1;
                    }
                    return Some(String::from_utf8_lossy(&decoded[start..end]).into_owned());
                }
            }
            cursor -= 1;
        }
    }
    None
}

/// `readMacOsArchivedFontName` — Terminal.app stores a font as archived `NSData`, so the name
/// is base64-wrapped binary rather than a string.
pub fn read_mac_os_archived_font_name(value: &Value) -> Option<String> {
    let raw_data = match value {
        Value::String(text) => Some(text.clone()),
        Value::Object(record) => record.get("NS").and_then(js_value_to_string),
        _ => None,
    };
    let normalized = normalize_font_family(raw_data.as_deref())?;
    let decoded = node_base64_decode(&normalized);
    let matched = find_archived_font_name(&decoded)?;
    normalize_mac_os_font_name(Some(&matched))
}

/// `normalizeColorComponent` — a float in 0..1, an 8-bit or a 16-bit integer, all folded into
/// 0..1. The three ranges overlap and are tried widest-last, so `0.5` stays `0.5` while `200`
/// becomes `200/255` and `300` becomes `300/65535`.
pub fn normalize_color_component(value: &Value) -> Option<f64> {
    let parsed = match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => js_parse_float(js_trim(text)),
        _ => f64::NAN,
    };
    if !parsed.is_finite() || parsed < 0.0 {
        return None;
    }
    if parsed <= 1.0 {
        return Some(parsed);
    }
    if parsed <= 255.0 {
        return Some(parsed / 255.0);
    }
    if parsed <= 65_535.0 {
        return Some(parsed / 65_535.0);
    }
    None
}

/// `readColorRecordValue` — the first of `names` that is *present*; `null` counts as present,
/// exactly as `record[name] !== undefined` did.
fn read_color_record_value<'a>(record: &'a Map<String, Value>, names: &[&str]) -> Option<&'a Value> {
    names
        .iter()
        .find_map(|name| record.get(*name))
}

fn is_hex_color(text: &str) -> bool {
    let bytes = text.as_bytes();
    let is_hex = |slice: &[u8]| slice.iter().all(u8::is_ascii_hexdigit);
    if bytes.len() < 4 || bytes[0] != b'#' {
        return false;
    }
    match bytes.len() - 1 {
        3 | 6 | 8 => is_hex(&bytes[1..]),
        _ => false,
    }
}

fn is_rgba_prefix(text: &str) -> bool {
    let lowered = text.to_ascii_lowercase();
    lowered.starts_with("rgba(") || lowered.starts_with("rgb(")
}

/// `normalizeMacOsColor` — a literal `#rgb`/`#rrggbb`/`#rrggbbaa` or `rgb()/rgba()` string
/// passes through untouched; an Apple colour record is folded into one of those two forms.
pub fn normalize_mac_os_color(value: &Value) -> Option<String> {
    if let Value::String(text) = value {
        let trimmed = js_trim(text);
        return if is_hex_color(trimmed) || is_rgba_prefix(trimmed) {
            Some(trimmed.to_owned())
        } else {
            None
        };
    }

    let record = value.as_object()?;
    let red = read_color_record_value(record, &["Red Component", "red", "Red"])
        .and_then(normalize_color_component);
    let green = read_color_record_value(record, &["Green Component", "green", "Green"])
        .and_then(normalize_color_component);
    let blue = read_color_record_value(record, &["Blue Component", "blue", "Blue"])
        .and_then(normalize_color_component);
    let alpha = read_color_record_value(
        record,
        &["Alpha Component", "alpha", "Alpha", "Opacity"],
    )
    .and_then(normalize_color_component)
    .unwrap_or(1.0);

    let (red, green, blue) = (red?, green?, blue?);
    let red = js_round(red * 255.0) as i64;
    let green = js_round(green * 255.0) as i64;
    let blue = js_round(blue * 255.0) as i64;
    if alpha < 1.0 {
        return Some(format!(
            "rgba({}, {}, {}, {})",
            red,
            green,
            blue,
            format_fixed_stripped(alpha, 3)
        ));
    }
    Some(format!(
        "#{:02x}{:02x}{:02x}",
        red.clamp(0, 255),
        green.clamp(0, 255),
        blue.clamp(0, 255)
    ))
}

/// `ANSI_THEME_KEYS` (`terminalProfileMacOs.ts:206-223`) — declaration order is the wire
/// order of the theme payload.
pub const ANSI_THEME_KEYS: [&str; 16] = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
];

fn set_theme_color(theme: &mut TerminalThemeProfile, key: &str, color: String) {
    let slot = match key {
        "foreground" => &mut theme.foreground,
        "background" => &mut theme.background,
        "cursor" => &mut theme.cursor,
        "cursorAccent" => &mut theme.cursor_accent,
        "selectionBackground" => &mut theme.selection_background,
        "black" => &mut theme.black,
        "red" => &mut theme.red,
        "green" => &mut theme.green,
        "yellow" => &mut theme.yellow,
        "blue" => &mut theme.blue,
        "magenta" => &mut theme.magenta,
        "cyan" => &mut theme.cyan,
        "white" => &mut theme.white,
        "brightBlack" => &mut theme.bright_black,
        "brightRed" => &mut theme.bright_red,
        "brightGreen" => &mut theme.bright_green,
        "brightYellow" => &mut theme.bright_yellow,
        "brightBlue" => &mut theme.bright_blue,
        "brightMagenta" => &mut theme.bright_magenta,
        "brightCyan" => &mut theme.bright_cyan,
        "brightWhite" => &mut theme.bright_white,
        _ => return,
    };
    *slot = Some(color);
}

/// `readThemeColor` — the first profile key that yields a usable colour wins.
fn read_theme_color(
    profile: &Map<String, Value>,
    theme: &mut TerminalThemeProfile,
    theme_key: &str,
    profile_keys: &[&str],
) {
    for profile_key in profile_keys {
        if let Some(color) = profile.get(*profile_key).and_then(normalize_mac_os_color) {
            set_theme_color(theme, theme_key, color);
            return;
        }
    }
}

/// `readIterm2Theme`.
pub fn read_iterm2_theme(profile: &Map<String, Value>) -> Option<TerminalThemeProfile> {
    let mut theme = TerminalThemeProfile::default();
    read_theme_color(profile, &mut theme, "foreground", &["Foreground Color"]);
    read_theme_color(profile, &mut theme, "background", &["Background Color"]);
    read_theme_color(profile, &mut theme, "cursor", &["Cursor Color"]);
    read_theme_color(profile, &mut theme, "cursorAccent", &["Cursor Text Color"]);
    read_theme_color(profile, &mut theme, "selectionBackground", &["Selection Color"]);
    for (index, key) in ANSI_THEME_KEYS.iter().enumerate() {
        let candidates = [format!("Ansi {index} Color"), format!("ANSI {index} Color")];
        read_theme_color(
            profile,
            &mut theme,
            key,
            &candidates.iter().map(String::as_str).collect::<Vec<_>>(),
        );
    }
    theme.compact()
}

/// `terminalAnsiNames` (`terminalProfileMacOs.ts:251-268`), aligned with [`ANSI_THEME_KEYS`].
const TERMINAL_ANSI_NAMES: [&str; 16] = [
    "ANSIBlackColor",
    "ANSIRedColor",
    "ANSIGreenColor",
    "ANSIYellowColor",
    "ANSIBlueColor",
    "ANSIMagentaColor",
    "ANSICyanColor",
    "ANSIWhiteColor",
    "ANSIBrightBlackColor",
    "ANSIBrightRedColor",
    "ANSIBrightGreenColor",
    "ANSIBrightYellowColor",
    "ANSIBrightBlueColor",
    "ANSIBrightMagentaColor",
    "ANSIBrightCyanColor",
    "ANSIBrightWhiteColor",
];

/// `readMacOsTerminalTheme`.
pub fn read_mac_os_terminal_theme(profile: &Map<String, Value>) -> Option<TerminalThemeProfile> {
    let mut theme = TerminalThemeProfile::default();
    read_theme_color(profile, &mut theme, "foreground", &["TextColor"]);
    read_theme_color(profile, &mut theme, "background", &["BackgroundColor"]);
    read_theme_color(profile, &mut theme, "cursor", &["CursorColor"]);
    read_theme_color(profile, &mut theme, "selectionBackground", &["SelectionColor"]);
    for (index, key) in ANSI_THEME_KEYS.iter().enumerate() {
        read_theme_color(profile, &mut theme, key, &[TERMINAL_ANSI_NAMES[index]]);
    }
    theme.compact()
}

/// `detectIterm2Profile` — over a plist that has already been read.
pub fn parse_iterm2_plist(plist: &Value) -> Option<TerminalDetectedProfile> {
    let profiles = plist
        .get("New Bookmarks")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    // `profiles.find(isDefault)` followed by "default first, the rest in order" is a stable
    // partition, so the index is all that has to be carried.
    let default_index = profiles.iter().position(|profile| {
        profile
            .as_object()
            .and_then(|record| record.get("Default Bookmark"))
            == Some(&Value::Bool(true))
    });

    let order: Vec<usize> = match default_index {
        Some(default) => std::iter::once(default)
            .chain((0..profiles.len()).filter(|index| *index != default))
            .collect(),
        None => (0..profiles.len()).collect(),
    };

    order
        .into_iter()
        .find_map(|index| iterm2_profile_of(&profiles[index]))
}

fn iterm2_profile_of(profile: &Value) -> Option<TerminalDetectedProfile> {
    let record = profile.as_object()?;
    let (font_family, font_size) =
        read_mac_os_font_descriptor(record.get("Normal Font").unwrap_or(NULL));
    TerminalDetectedProfile {
        font_family,
        font_size,
        theme: read_iterm2_theme(record),
    }
    .normalized()
}

/// `detectMacOsTerminalProfile` — over a plist that has already been read.
pub fn parse_mac_os_terminal_plist(plist: &Value) -> Option<TerminalDetectedProfile> {
    let settings_names = [
        read_nested_string(plist, &["Startup Window Settings"]),
        read_nested_string(plist, &["Default Window Settings"]),
    ];

    for settings_name in settings_names.into_iter().flatten() {
        let Some(settings) = plist.get(&settings_name).and_then(Value::as_object) else {
            continue;
        };
        let font = settings.get("Font").unwrap_or(NULL);
        // Only the *size* of the `Font` descriptor is consulted for the family: the legacy
        // chain is FontName → normalised Font → archived Font, with no descriptor family.
        let descriptor_size = read_mac_os_font_descriptor(font).1;
        let detected = TerminalDetectedProfile {
            font_family: read_nested_string_in_object(settings, &["FontName"])
                .or_else(|| {
                    normalize_mac_os_font_name(
                        read_nested_string_in_object(settings, &["Font"]).as_deref(),
                    )
                })
                .or_else(|| read_mac_os_archived_font_name(font)),
            font_size: settings
                .get("FontSize")
                .and_then(normalize_font_size)
                .or(descriptor_size),
            theme: read_mac_os_terminal_theme(settings),
        };
        if let Some(detected) = detected.normalized() {
            return Some(detected);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(raw: &str) -> Value {
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn font_size_clamp_boundaries() {
        assert_eq!(normalize_font_size(&value("6")), Some(6.0));
        assert_eq!(normalize_font_size(&value("72")), Some(72.0));
        assert_eq!(normalize_font_size(&value("5.9")), None);
        assert_eq!(normalize_font_size(&value("72.1")), None);
        // `parseFloat` prefix semantics, not a whole-string parse.
        assert_eq!(normalize_font_size(&value("\"12pt\"")), Some(12.0));
        assert_eq!(normalize_font_size(&value("\" 13 \"")), Some(13.0));
        assert_eq!(normalize_font_size(&value("\"abc\"")), None);
        assert_eq!(normalize_font_size(&value("\"\"")), None);
        assert_eq!(normalize_font_size(&value("true")), None);
        assert_eq!(normalize_font_size(&Value::Null), None);
    }

    #[test]
    fn mac_os_font_name_rules() {
        // A size is only stripped when whitespace separates it, which is why a real
        // `"Monaco-10"` keeps its digits in the family and yields no size.
        assert_eq!(normalize_mac_os_font_name(Some("Monaco-10")).as_deref(), Some("Monaco 10"));
        assert_eq!(read_mac_os_font_descriptor(&value("\"Monaco-10\"")), (Some("Monaco 10".to_owned()), None));
        assert_eq!(normalize_mac_os_font_name(Some("SF Mono 12")).as_deref(), Some("SF Mono"));
        assert_eq!(
            read_mac_os_font_descriptor(&value("\"SFMono-Regular 12\"")),
            (Some("SFMono Regular".to_owned()), Some(12.0))
        );
        assert_eq!(normalize_mac_os_font_name(Some("   ")), None);
        assert_eq!(normalize_mac_os_font_name(None), None);
    }

    #[test]
    fn trailing_number_takes_the_last_one() {
        assert_eq!(trailing_number("SFMono 12 13"), Some((10, "13")));
        // `\s+` is required, so a bare number at the end is not a size.
        assert_eq!(trailing_number("Monaco-10"), None);
        // `1.2.3` cannot satisfy `\d+(\.\d+)?$`.
        assert_eq!(trailing_number("Foo 1.2.3"), None);
        assert_eq!(trailing_number("Foo 1.25"), Some((4, "1.25")));
    }

    #[test]
    fn color_component_ranges() {
        assert_eq!(normalize_color_component(&value("0.5")), Some(0.5));
        assert_eq!(normalize_color_component(&value("200")), Some(200.0 / 255.0));
        // 300 is past the 8-bit range and folds through the 16-bit one.
        assert_eq!(normalize_color_component(&value("300")), Some(300.0 / 65_535.0));
        assert_eq!(normalize_color_component(&value("65535")), Some(1.0));
        assert_eq!(normalize_color_component(&value("65536")), None);
        assert_eq!(normalize_color_component(&value("-1")), None);
        assert_eq!(normalize_color_component(&value("\"0.25\"")), Some(0.25));
        assert_eq!(normalize_color_component(&value("\"nope\"")), None);
    }

    #[test]
    fn mac_os_color_formats() {
        assert_eq!(normalize_mac_os_color(&value("\"#abc\"")).as_deref(), Some("#abc"));
        assert_eq!(normalize_mac_os_color(&value("\"#AABBCC\"")).as_deref(), Some("#AABBCC"));
        assert_eq!(normalize_mac_os_color(&value("\"#aabbccdd\"")).as_deref(), Some("#aabbccdd"));
        // Four hex digits matches nothing; the groups are 3, 3 and 2.
        assert_eq!(normalize_mac_os_color(&value("\"#abcd\"")), None);
        // `rgba(` is a prefix test, not a parse.
        assert_eq!(normalize_mac_os_color(&value("\"rgba(garbage\"")).as_deref(), Some("rgba(garbage"));
        assert_eq!(normalize_mac_os_color(&value("\"#zzz\"")), None);
        // Math.round is half-up: 0.1*255 = 25.5 -> 26 = 1a.
        assert_eq!(
            normalize_mac_os_color(&value(r#"{"Red Component":0.1,"Green Component":0.2,"Blue Component":0.3}"#)).as_deref(),
            Some("#1a334d")
        );
        // toFixed(3) then unary + strips the trailing zeros.
        assert_eq!(
            normalize_mac_os_color(&value(
                r#"{"Red Component":0.5,"Green Component":0.5,"Blue Component":0.5,"Alpha Component":0.5}"#
            ))
            .as_deref(),
            Some("rgba(128, 128, 128, 0.5)")
        );
        // A missing green or blue drops the whole colour.
        assert_eq!(normalize_mac_os_color(&value(r#"{"Red Component":0.1}"#)), None);
        // A non-object, non-string value is not a colour.
        assert_eq!(normalize_mac_os_color(&value("[1,2]")), None);
        assert_eq!(normalize_mac_os_color(&value("7")), None);
    }

    #[test]
    fn archived_font_name_is_recovered_from_base64() {
        let encoded = "U0YgTW9ubyAxMw==";
        assert_eq!(
            read_mac_os_archived_font_name(&Value::String(encoded.to_owned())).as_deref(),
            Some("SF Mono")
        );
        let with_size = read_mac_os_archived_font_name(&Value::String(encoded.to_owned()));
        assert!(with_size.is_some());
        // `NS` is read from an object as well as from a bare string.
        assert_eq!(
            read_mac_os_archived_font_name(&value(&format!(r#"{{"NS":"{encoded}"}}"#))).as_deref(),
            Some("SF Mono")
        );
        // No font-shaped token in the blob means no family.
        assert_eq!(read_mac_os_archived_font_name(&Value::String("aGVsbG8=".to_owned())), None);
        assert_eq!(read_mac_os_archived_font_name(&Value::String("   ".to_owned())), None);
        assert_eq!(read_mac_os_archived_font_name(&value("[1]")), None);
    }

    #[test]
    fn plist_non_object_yields_nothing() {
        assert_eq!(parse_iterm2_plist(&value("[1, 2]")), None);
        assert_eq!(parse_mac_os_terminal_plist(&value("\"nope\"")), None);
        // A settings name that is not a string cannot name a settings dict.
        assert_eq!(parse_mac_os_terminal_plist(&value(r#"{"Startup Window Settings": 7}"#)), None);
    }

    #[test]
    fn iterm2_prefers_the_default_bookmark() {
        let plist = value(
            r#"{"New Bookmarks":[
                {"Normal Font":"Other 10"},
                {"Normal Font":"Chosen 12","Default Bookmark":true}
            ]}"#,
        );
        let detected = parse_iterm2_plist(&plist).unwrap();
        assert_eq!(detected.font_family.as_deref(), Some("Chosen"));
        assert_eq!(detected.font_size, Some(12.0));
    }

    #[test]
    fn iterm2_falls_through_profiles_with_nothing_detectable() {
        let plist = value(
            r#"{"New Bookmarks":[
                {"Name":"empty"},
                {"Normal Font":"Second 11"}
            ]}"#,
        );
        assert_eq!(
            parse_iterm2_plist(&plist).unwrap().font_family.as_deref(),
            Some("Second")
        );
        assert_eq!(parse_iterm2_plist(&value(r#"{"New Bookmarks":[]}"#)), None);
        assert_eq!(parse_iterm2_plist(&value("{}")), None);
    }

    #[test]
    fn mac_os_terminal_prefers_the_startup_settings() {
        let plist = value(
            r#"{
                "Startup Window Settings":"Basic",
                "Default Window Settings":"Pro",
                "Basic":{"FontName":"Andale Mono","FontSize":13},
                "Pro":{"FontName":"Pro Font","FontSize":15}
            }"#,
        );
        let detected = parse_mac_os_terminal_plist(&plist).unwrap();
        assert_eq!(detected.font_family.as_deref(), Some("Andale Mono"));
        assert_eq!(detected.font_size, Some(13.0));
    }

    #[test]
    fn mac_os_terminal_falls_back_to_the_archived_font() {
        let plist = value(
            r#"{
                "Startup Window Settings":"Basic",
                "Basic":{"Font":{"NS":"U0YgTW9ubyAxMw=="}}
            }"#,
        );
        let detected = parse_mac_os_terminal_plist(&plist).unwrap();
        assert_eq!(detected.font_family.as_deref(), Some("SF Mono"));
        // The size comes from `readMacOsFontDescriptor(settings.Font)`, which stringifies the
        // *object* to `"[object Object]"` — so an archived font yields a family and no size.
        assert_eq!(detected.font_size, None);
    }

    #[test]
    fn mac_os_terminal_reads_the_ansi_palette() {
        let plist = value(
            r#"{
                "Startup Window Settings":"Basic",
                "Basic":{"FontName":"Andale Mono",
                         "TextColor":{"Red Component":1,"Green Component":1,"Blue Component":1},
                         "ANSIBlackColor":{"Red Component":0,"Green Component":0,"Blue Component":0}}
            }"#,
        );
        let theme = parse_mac_os_terminal_plist(&plist).unwrap().theme.unwrap();
        assert_eq!(theme.foreground.as_deref(), Some("#ffffff"));
        assert_eq!(theme.black.as_deref(), Some("#000000"));
        assert_eq!(theme.red, None, "unset ANSI keys stay absent");
    }
}
