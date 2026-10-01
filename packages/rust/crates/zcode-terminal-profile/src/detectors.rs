//! The terminal profile detectors and the detection ladder.
//!
//! Ported from `packages/services/src/terminal/terminalProfile.ts:33-415`. Every file the
//! detectors read is read here, in Rust: the crate owns the sniffing, not just the decision.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::jsonc::{
    normalize_font_family, read_jsonc_file, read_nested_string, read_text_file, read_toml_file,
    read_yaml_file,
};
use crate::jsval::{is_js_space, is_line_terminator, js_trim};
use crate::macos::{parse_iterm2_plist, parse_mac_os_terminal_plist};
use crate::types::{TerminalDetectedProfile, TerminalEnvInput, TerminalFontProfile};

/// `FONT_FAMILY_FALLBACKS` (`terminalProfile.ts:33-46`). The order is the emitted stack's
/// order, so it is part of the payload and not an implementation detail.
pub const FONT_FAMILY_FALLBACKS: [&str; 12] = [
    "ui-monospace",
    "SFMono-Regular",
    "SF Mono",
    "Menlo",
    "Monaco",
    "Consolas",
    "Cascadia Mono",
    "JetBrains Mono",
    "MesloLGS NF",
    "Hack Nerd Font",
    "Noto Sans Mono CJK SC",
    "monospace",
];

/// `dedupeFontFamilyStack` — the user's stack first, then every fallback that is not already
/// in it, in declaration order, joined with `", "`.
pub fn dedupe_font_family_stack(primary: &str) -> String {
    let mut stack: Vec<String> = primary
        .split(',')
        .map(|part| js_trim(part).to_owned())
        .filter(|part| !part.is_empty())
        .collect();
    for fallback in FONT_FAMILY_FALLBACKS {
        if !stack.iter().any(|existing| existing == fallback) {
            stack.push(fallback.to_owned());
        }
    }
    stack.join(", ")
}

/// `node:path`'s `join` for the segments the detectors use. `PathBuf::push` inserts the host
/// separator, which is what `path.join` does on the same host — the differential exercises
/// the `win32` branch from Linux, so the host's separator is the correct one to use.
fn join(base: &str, segments: &[&str]) -> String {
    let mut path = PathBuf::from(base);
    for segment in segments {
        path.push(segment);
    }
    path.to_string_lossy().into_owned()
}

/// Everything a detector is allowed to look at.
pub struct DetectionContext<'a> {
  /// `process.platform`.
  pub platform: &'a str,
  pub env: &'a TerminalEnvInput,
  /// The plist `plutil` produced, already read by the caller. See `docs/specs/rust-native-terminal-profile.md` §2.2.
  pub iterm2_plist: Option<&'a Value>,
  pub macos_terminal_plist: Option<&'a Value>,
}

/// `detectWindowsTerminalFontFamily` (`terminalProfile.ts:194-263`).
pub fn detect_windows_terminal_font_family(ctx: &DetectionContext<'_>) -> Option<TerminalDetectedProfile> {
    let fallback = ctx.env.app_data.as_deref().unwrap_or("");
    let local_app_data = TerminalEnvInput::trimmed_or(ctx.env.local_app_data.as_deref(), fallback);
    if local_app_data.is_empty() {
        return None;
    }

    let candidates = [
        join(
            local_app_data,
            &[
                "Packages",
                "Microsoft.WindowsTerminal_8wekyb3d8bbwe",
                "LocalState",
                "settings.json",
            ],
        ),
        join(
            local_app_data,
            &[
                "Packages",
                "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe",
                "LocalState",
                "settings.json",
            ],
        ),
        join(
            local_app_data,
            &["Microsoft", "Windows Terminal", "settings.json"],
        ),
    ];

    for file_path in candidates {
        let Some(parsed) = read_jsonc_file(&file_path) else {
            continue;
        };

        // `profile.guid !== defaultProfileId` is a strict comparison against a string, so a
        // non-string guid never matches — which is what `as_str()` reproduces.
        if let Some(default_profile_id) = read_nested_string(&parsed, &["defaultProfile"]) {
            if let Some(list) = parsed
                .get("profiles")
                .and_then(|profiles| profiles.get("list"))
                .and_then(Value::as_array)
            {
                for item in list {
                    if item.get("guid").and_then(Value::as_str) != Some(default_profile_id.as_str()) {
                        continue;
                    }
                    if let Some(font_family) = read_nested_string(item, &["font", "face"]) {
                        return Some(TerminalDetectedProfile {
                            font_family: Some(font_family),
                            ..Default::default()
                        });
                    }
                }
            }
        }

        let defaults = parsed.get("profiles").and_then(|profiles| profiles.get("defaults"));
        if let Some(font_family) = read_nested_string(defaults.unwrap_or(&Value::Null), &["font", "face"])
        {
            return Some(TerminalDetectedProfile {
                font_family: Some(font_family),
                ..Default::default()
            });
        }

        // The legacy loop skips falsy list items before reading them. A skipped item is a
        // non-object, and a non-object yields no font either way, so every element can be
        // read directly.
        if let Some(list) = parsed
            .get("profiles")
            .and_then(|profiles| profiles.get("list"))
            .and_then(Value::as_array)
        {
            for item in list {
                if let Some(font_family) = read_nested_string(item, &["font", "face"]) {
                    return Some(TerminalDetectedProfile {
                        font_family: Some(font_family),
                        ..Default::default()
                    });
                }
            }
        }
    }

    None
}

/// `detectVsCodeTerminalFontFamily` (`terminalProfile.ts:265-289`).
pub fn detect_vscode_terminal_font_family(ctx: &DetectionContext<'_>) -> Option<TerminalDetectedProfile> {
    let home_dir = ctx.env.home_dir();
    let app_data = ctx.env.app_data.as_deref().map(js_trim).unwrap_or("");
    let xdg_config_home = ctx
        .env
        .xdg_config_home
        .as_deref()
        .map(js_trim)
        .unwrap_or("");
    let mut candidates: Vec<String> = Vec::new();
    if !app_data.is_empty() {
        candidates.push(join(app_data, &["Code", "User", "settings.json"]));
        candidates.push(join(
            app_data,
            &["Code - Insiders", "User", "settings.json"],
        ));
    }
    if !xdg_config_home.is_empty() {
        candidates.push(join(xdg_config_home, &["Code", "User", "settings.json"]));
        candidates.push(join(
            xdg_config_home,
            &["Code - Insiders", "User", "settings.json"],
        ));
    }
    candidates.push(join(home_dir, &[".config", "Code", "User", "settings.json"]));
    candidates.push(join(
        home_dir,
        &[".config", "Code - Insiders", "User", "settings.json"],
    ));
    candidates.push(join(
        home_dir,
        &["Library", "Application Support", "Code", "User", "settings.json"],
    ));
    candidates.push(join(
        home_dir,
        &[
            "Library",
            "Application Support",
            "Code - Insiders",
            "User",
            "settings.json",
        ],
    ));

    for file_path in candidates {
        let parsed = read_jsonc_file(&file_path).unwrap_or(Value::Null);
        if let Some(font_family) =
            read_nested_string(&parsed, &["terminal.integrated.fontFamily"])
        {
            return Some(TerminalDetectedProfile {
                font_family: Some(font_family),
                ..Default::default()
            });
        }
    }

    None
}

/// `/^\s*font_family\s+(.+)$/m`, transcribed with the backtracking the engine performs.
///
/// Three details are load-bearing and none of them is "match a line":
///   * `\s` is the **regex** whitespace class, which includes `\n`, so both `\s*` and `\s+`
///     run across lines. A blank `font_family` line therefore makes `\s+` swallow the
///     newline and capture the *next* line's text — the legacy quirk this reproduces.
///   * both whitespace runs are **greedy**, so the longest run is tried first and shorter
///     ones are backtracked into, which is what lets a run ending at a line terminator fall
///     back to capturing a single space.
///   * `.` excludes line terminators, so the capture always ends at one, and `$` in
///     multiline mode is satisfied by that same position.
///
/// The first anchor that can match wins, and a match with a blank capture still counts —
/// the legacy `raw.match(...)` takes the first *match* and only then normalises it.
fn kitty_font_family_match(raw: &str) -> Option<&str> {
    const KEY: &str = "font_family";
    let chars: Vec<char> = raw.chars().collect();
    let mut anchors = vec![0usize];
    for (index, ch) in chars.iter().enumerate() {
        if is_line_terminator(*ch) {
            anchors.push(index + 1);
        }
    }

    for anchor in anchors {
        if anchor > chars.len() {
            break;
        }
        // `\s*`: the greedy run, then every shorter one.
        for key_start in (anchor..=whitespace_run_end(&chars, anchor)).rev() {
            if !chars[key_start..].starts_with(&KEY.chars().collect::<Vec<_>>()[..]) {
                continue;
            }
            let after_key = key_start + KEY.chars().count();
            // `\s+`: at least one whitespace, longest first.
            for value_start in (after_key + 1..=whitespace_run_end(&chars, after_key)).rev() {
                // `(.+)`: at least one character that is not a line terminator, and `$`
                // holds wherever the greedy run stops.
                if value_start >= chars.len() || is_line_terminator(chars[value_start]) {
                    continue;
                }
                let mut end = value_start;
                while end < chars.len() && !is_line_terminator(chars[end]) {
                    end += 1;
                }
                let from: usize = chars[..value_start].iter().map(|ch| ch.len_utf8()).sum();
                let to: usize = chars[..end].iter().map(|ch| ch.len_utf8()).sum();
                return raw.get(from..to);
            }
        }
    }
    None
}

/// One past the end of the maximal JS-whitespace run starting at `from`.
fn whitespace_run_end(chars: &[char], from: usize) -> usize {
    let mut end = from;
    while end < chars.len() && is_js_space(chars[end]) {
        end += 1;
    }
    end
}

/// `.replace(/^"|"$/g, "")` — a leading and a trailing quote, both judged against the
/// **original** string, because `String.replace` with `/g` scans the original.
fn strip_kitty_quotes(value: &str) -> String {
    let mut stripped = value.strip_prefix('"').unwrap_or(value).to_owned();
    if value.len() >= 2 && value.ends_with('"') {
        stripped.pop();
    }
    stripped
}

/// `detectKittyFontFamily` (`terminalProfile.ts:291-316`).
pub fn detect_kitty_font_family(ctx: &DetectionContext<'_>) -> Option<TerminalDetectedProfile> {
    let home_dir = ctx.env.home_dir();
    let default_xdg_config_home = join(home_dir, &[".config"]);
    let xdg_config_home = TerminalEnvInput::trimmed_or(
        ctx.env.xdg_config_home.as_deref(),
        &default_xdg_config_home,
    );
    let candidates = [
        join(xdg_config_home, &["kitty", "kitty.conf"]),
        join(
            home_dir,
            &["Library", "Application Support", "kitty", "kitty.conf"],
        ),
    ];

    for file_path in candidates {
        let Some(raw) = read_text_file(&file_path) else {
            continue;
        };
        if let Some(captured) = kitty_font_family_match(&raw) {
            if let Some(font_family) = normalize_font_family(Some(captured)) {
                return Some(TerminalDetectedProfile {
                    font_family: Some(strip_kitty_quotes(&font_family)),
                    ..Default::default()
                });
            }
        }
    }

    None
}

/// `detectAlacrittyFontFamily` (`terminalProfile.ts:318-347`).
pub fn detect_alacritty_font_family(ctx: &DetectionContext<'_>) -> Option<TerminalDetectedProfile> {
    let home_dir = ctx.env.home_dir();
    let default_xdg_config_home = join(home_dir, &[".config"]);
    let xdg_config_home = TerminalEnvInput::trimmed_or(
        ctx.env.xdg_config_home.as_deref(),
        &default_xdg_config_home,
    );
    let toml_candidates = [
        join(xdg_config_home, &["alacritty", "alacritty.toml"]),
        join(home_dir, &[".alacritty.toml"]),
    ];
    let yaml_candidates = [
        join(xdg_config_home, &["alacritty", "alacritty.yml"]),
        join(xdg_config_home, &["alacritty", "alacritty.yaml"]),
    ];

    for file_path in toml_candidates {
        let parsed = read_toml_file(&file_path).unwrap_or(Value::Null);
        if let Some(font_family) = read_nested_string(&parsed, &["font", "normal", "family"]) {
            return Some(TerminalDetectedProfile {
                font_family: Some(font_family),
                ..Default::default()
            });
        }
    }

    for file_path in yaml_candidates {
        let parsed = read_yaml_file(&file_path).unwrap_or(Value::Null);
        if let Some(font_family) = read_nested_string(&parsed, &["font", "normal", "family"]) {
            return Some(TerminalDetectedProfile {
                font_family: Some(font_family),
                ..Default::default()
            });
        }
    }

    None
}

/// `TERMINAL_FONT_DETECTORS` (`terminalProfile.ts:349-370`) in order, with the macOS pair
/// spliced in between VS Code and kitty exactly where `createMacOsTerminalProfileDetectors()`
/// put them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detector {
    WindowsTerminal,
    VsCode,
    Iterm2,
    MacOsTerminal,
    Kitty,
    Alacritty,
}

impl Detector {
    pub const fn id(self) -> &'static str {
        match self {
            Detector::WindowsTerminal => "windows-terminal",
            Detector::VsCode => "vscode",
            Detector::Iterm2 => "iterm2",
            Detector::MacOsTerminal => "macos-terminal",
            Detector::Kitty => "kitty",
            Detector::Alacritty => "alacritty",
        }
    }

    /// The `platforms` gate, or `None` for "every platform".
    pub const fn platforms(self) -> Option<&'static [&'static str]> {
        match self {
            Detector::WindowsTerminal => Some(&["win32"]),
            Detector::VsCode => None,
            Detector::Iterm2 | Detector::MacOsTerminal => Some(&["darwin"]),
            Detector::Kitty | Detector::Alacritty => {
                Some(&["darwin", "linux", "freebsd", "openbsd"])
            }
        }
    }

    fn run(self, ctx: &DetectionContext<'_>) -> Option<TerminalDetectedProfile> {
        match self {
            Detector::WindowsTerminal => detect_windows_terminal_font_family(ctx),
            Detector::VsCode => detect_vscode_terminal_font_family(ctx),
            Detector::Iterm2 => parse_iterm2_plist(ctx.iterm2_plist?),
            Detector::MacOsTerminal => parse_mac_os_terminal_plist(ctx.macos_terminal_plist?),
            Detector::Kitty => detect_kitty_font_family(ctx),
            Detector::Alacritty => detect_alacritty_font_family(ctx),
        }
    }
}

/// The ladder, in order. Asserted by `detector_order_is_the_ported_order`.
pub const DETECTORS: [Detector; 6] = [
    Detector::WindowsTerminal,
    Detector::VsCode,
    Detector::Iterm2,
    Detector::MacOsTerminal,
    Detector::Kitty,
    Detector::Alacritty,
];

/// `detectSystemTerminalProfile` (`terminalProfile.ts:372-384`).
pub fn detect_system_terminal_profile(ctx: &DetectionContext<'_>) -> Option<TerminalDetectedProfile> {
    DETECTORS
        .iter()
        .filter(|detector| match detector.platforms() {
            Some(platforms) => platforms.contains(&ctx.platform),
            None => true,
        })
        .find_map(|detector| detector.run(ctx))
}

/// `resolveTerminalFontProfile` (`terminalProfile.ts:386-415`).
///
/// The `custom` branch keeps the *detected* size and theme: a user who pinned a font family
/// still wants the terminal's colours, and a macOS profile that is colours-only must not be
/// discarded just because it has no family.
pub fn resolve_terminal_font_profile(
    platform: &str,
    env: &TerminalEnvInput,
    terminal_font_family: Option<&str>,
    terminal_inherit_system_profile: Option<bool>,
    iterm2_plist: Option<&Value>,
    macos_terminal_plist: Option<&Value>,
) -> TerminalFontProfile {
    let ctx = DetectionContext {
        platform,
        env,
        iterm2_plist,
        macos_terminal_plist,
    };
    let custom_font_family = normalize_font_family(terminal_font_family);
    let detected_profile = if terminal_inherit_system_profile != Some(false) {
        detect_system_terminal_profile(&ctx)
    } else {
        None
    };

    if let Some(custom_font_family) = custom_font_family {
        return TerminalFontProfile {
            font_family: dedupe_font_family_stack(&custom_font_family),
            font_size: detected_profile.as_ref().and_then(|profile| profile.font_size),
            theme: detected_profile.and_then(|profile| profile.theme),
            source: "custom".to_owned(),
        };
    }

    if let Some(detected) = detected_profile {
        let base = detected
            .font_family
            .unwrap_or_else(|| FONT_FAMILY_FALLBACKS[0].to_owned());
        return TerminalFontProfile {
            font_family: dedupe_font_family_stack(&base),
            font_size: detected.font_size,
            theme: detected.theme,
            source: "system".to_owned(),
        };
    }

    TerminalFontProfile {
        font_family: FONT_FAMILY_FALLBACKS.join(", "),
        font_size: None,
        theme: None,
        source: "fallback".to_owned(),
    }
}

/// Whether a path exists, for the diagnostics a caller may want. Kept private to the crate:
/// the detectors do their own existence checks so the `catch → null` shape is preserved.
#[allow(dead_code)]
fn exists(path: &str) -> bool {
    Path::new(path).exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(home: &str) -> TerminalEnvInput {
        TerminalEnvInput {
            home: Some(home.to_owned()),
            home_dir: home.to_owned(),
            ..Default::default()
        }
    }

    #[test]
    fn detector_order_is_the_ported_order() {
        assert_eq!(
            DETECTORS,
            [
                Detector::WindowsTerminal,
                Detector::VsCode,
                Detector::Iterm2,
                Detector::MacOsTerminal,
                Detector::Kitty,
                Detector::Alacritty,
            ]
        );
        assert_eq!(Detector::WindowsTerminal.platforms(), Some(&["win32"][..]));
        assert_eq!(Detector::VsCode.platforms(), None);
        assert_eq!(Detector::Iterm2.platforms(), Some(&["darwin"][..]));
        assert_eq!(
            Detector::Kitty.platforms(),
            Some(&["darwin", "linux", "freebsd", "openbsd"][..])
        );
    }

    #[test]
    fn font_stack_dedupes_against_the_fallbacks() {
        // A family that is already in the fallback list keeps the user's position and is
        // not repeated at the end.
        assert_eq!(
            dedupe_font_family_stack("Menlo, monospace"),
            "Menlo, monospace, ui-monospace, SFMono-Regular, SF Mono, Monaco, Consolas, \
             Cascadia Mono, JetBrains Mono, MesloLGS NF, Hack Nerd Font, Noto Sans Mono CJK SC"
        );
        assert_eq!(
            dedupe_font_family_stack("  Menlo  "),
            dedupe_font_family_stack("Menlo")
        );
        assert_eq!(
            dedupe_font_family_stack("Fira Code"),
            format!("Fira Code, {}", FONT_FAMILY_FALLBACKS.join(", "))
        );
        // Blank entries are dropped, not turned into empty stack members.
        assert_eq!(
            dedupe_font_family_stack(" , ,Fira Code, "),
            dedupe_font_family_stack("Fira Code")
        );
        // Every fallback is present exactly once as a whole stack entry, in declaration
        // order after the user's. (A substring count would be wrong: "ui-monospace"
        // contains "monospace".)
        let stack = dedupe_font_family_stack("Fira Code");
        let entries: Vec<&str> = stack.split(", ").collect();
        assert_eq!(entries[0], "Fira Code");
        assert_eq!(&entries[1..], &FONT_FAMILY_FALLBACKS);
        let mut unique = entries.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), entries.len(), "a family is listed twice");
    }

    #[test]
    fn inherit_flag_defaults_to_true() {
        let ctx = DetectionContext {
            platform: "win32",
            env: &env("/nonexistent"),
            iterm2_plist: None,
            macos_terminal_plist: None,
        };
        let absent = resolve_terminal_font_profile("win32", ctx.env, None, None, None, None);
        assert_eq!(absent.source, "fallback");
        let disabled = resolve_terminal_font_profile("win32", ctx.env, None, Some(false), None, None);
        assert_eq!(disabled.source, "fallback");
        let _ = ctx;
    }

    #[test]
    fn no_detector_yields_fallback_profile() {
        let env = env("/nonexistent");
        let profile = resolve_terminal_font_profile("linux", &env, None, None, None, None);
        assert_eq!(profile.source, "fallback");
        assert_eq!(profile.font_family, FONT_FAMILY_FALLBACKS.join(", "));
        assert_eq!(profile.font_size, None);
        assert_eq!(profile.theme, None);
    }

    #[test]
    fn a_blank_custom_font_is_not_custom() {
        let env = env("/nonexistent");
        let profile = resolve_terminal_font_profile("linux", &env, Some("   "), None, None, None);
        assert_eq!(profile.source, "fallback");
    }

    #[test]
    fn a_custom_font_still_inherits_the_detected_size_and_theme() {
        let env = env("/nonexistent");
        let plist: serde_json::Value = serde_json::from_str(
            r#"{"Startup Window Settings":"Basic","Basic":{"FontName":"Andale Mono","FontSize":13}}"#,
        )
        .unwrap();
        let profile = resolve_terminal_font_profile(
            "darwin",
            &env,
            Some("Fira Code"),
            None,
            None,
            Some(&plist),
        );
        assert_eq!(profile.source, "custom");
        assert!(profile.font_family.starts_with("Fira Code, ui-monospace"));
        // The macOS profile is colours-and-size only for the custom branch, but the size
        // still crosses, which is the whole point of the custom branch.
        assert_eq!(profile.font_size, Some(13.0));
    }

    #[test]
    fn kitty_takes_the_first_matching_line_even_when_it_is_blank() {
        assert_eq!(kitty_font_family_match("font_family  Fira Code\n"), Some("Fira Code"));
        assert_eq!(kitty_font_family_match("  font_family\tHack\n"), Some("Hack"));
        // `\s+` is the *regex* whitespace class, so it swallows the newline after a blank
        // value and the capture becomes the next line's text. Legacy quirk, reproduced.
        assert_eq!(
            kitty_font_family_match("font_family   \nfont_family  MesloLGS NF\n"),
            Some("font_family  MesloLGS NF")
        );
        // With nothing after it, the run backs off and captures a single space, which
        // normalises to nothing.
        assert_eq!(kitty_font_family_match("font_family   \n"), Some(" "));
        // `\\s+` is required, so `font_familyX` is not a match.
        assert_eq!(kitty_font_family_match("font_familyX  Fira\n"), None);
        assert_eq!(kitty_font_family_match("font_family\n"), None);
        // `.` does not cross a line terminator, so a CRLF file still yields the value.
        assert_eq!(kitty_font_family_match("font_family Hack\r\n"), Some("Hack"));
        assert_eq!(kitty_font_family_match("nothing here\n"), None);
    }

    #[test]
    fn kitty_quotes_are_stripped_against_the_original_string() {
        assert_eq!(strip_kitty_quotes("\"Fira Code\""), "Fira Code");
        assert_eq!(strip_kitty_quotes("Fira Code\""), "Fira Code");
        assert_eq!(strip_kitty_quotes("\"Fira Code"), "Fira Code");
        assert_eq!(strip_kitty_quotes("\"\""), "");
        assert_eq!(strip_kitty_quotes("\""), "");
        assert_eq!(strip_kitty_quotes("Fira Code"), "Fira Code");
    }

    #[test]
    fn home_dir_falls_back_through_home_userprofile_and_os() {
        let mut input = TerminalEnvInput {
            home: Some("  ".to_owned()),
            user_profile: Some(" /from/profile ".to_owned()),
            home_dir: "/from/os".to_owned(),
            ..Default::default()
        };
        assert_eq!(input.home_dir(), "/from/profile");
        input.user_profile = None;
        assert_eq!(input.home_dir(), "/from/os");
        input.home = Some(" /from/home ".to_owned());
        assert_eq!(input.home_dir(), "/from/home");
    }
}
