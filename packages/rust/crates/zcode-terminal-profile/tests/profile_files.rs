//! The detection ladder over a real fixture tree.
//!
//! These are the file-based half of the differential recorded in
//! `docs/specs/rust-native-terminal-profile.md` §7: the same named cases that were compared
//! against the deleted TypeScript implementation, kept as the permanent regression suite
//! because the legacy module no longer exists to compare against.

use std::path::{Path, PathBuf};

use serde_json::Value;
use zcode_terminal_profile::detectors::{resolve_terminal_font_profile, FONT_FAMILY_FALLBACKS};
use zcode_terminal_profile::types::{TerminalEnvInput, TerminalFontProfile};

/// A throwaway `$HOME`. Each test gets its own so the detector candidate lists cannot leak
/// into one another through a shared parent directory.
struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!("zcode-tp-fixture-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn write(&self, relative: &str, contents: &str) -> PathBuf {
        let path = self.root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, contents).unwrap();
        path
    }

    fn home(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn env_for(home: &str) -> TerminalEnvInput {
    TerminalEnvInput {
        home: Some(home.to_owned()),
        home_dir: home.to_owned(),
        xdg_config_home: Some(Path::new(home).join(".config").to_string_lossy().into_owned()),
        ..Default::default()
    }
}

fn detect(
    fixture: &Fixture,
    platform: &str,
    terminal_font_family: Option<&str>,
    terminal_inherit_system_profile: Option<bool>,
) -> TerminalFontProfile {
    let env = env_for(&fixture.home());
    resolve_terminal_font_profile(
        platform,
        &env,
        terminal_font_family,
        terminal_inherit_system_profile,
        None,
        None,
    )
}

/// The Windows Terminal detector reads `%LOCALAPPDATA%`, never the `$HOME` projection the
/// unix detectors use.
fn detect_windows(
    fixture: &Fixture,
    terminal_font_family: Option<&str>,
    terminal_inherit_system_profile: Option<bool>,
) -> TerminalFontProfile {
    let mut env = env_for(&fixture.home());
    env.local_app_data = Some(
        Path::new(&fixture.home())
            .join("AppData/Local")
            .to_string_lossy()
            .into_owned(),
    );
    resolve_terminal_font_profile(
        "win32",
        &env,
        terminal_font_family,
        terminal_inherit_system_profile,
        None,
        None,
    )
}

fn json(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap()
}

fn full_fallback_stack() -> String {
    FONT_FAMILY_FALLBACKS.join(", ")
}

#[test]
fn no_config_yields_the_fallback_profile() {
    let fixture = Fixture::new("empty");
    let profile = detect(&fixture, "linux", None, None);
    assert_eq!(profile.source, "fallback");
    assert_eq!(profile.font_family, full_fallback_stack());
    assert_eq!(profile.font_size, None);
    assert_eq!(profile.theme, None);
}

#[test]
fn a_custom_font_is_deduped_against_the_fallback_stack() {
    let fixture = Fixture::new("custom");
    let profile = detect(&fixture, "linux", Some("Fira Code"), None);
    assert_eq!(profile.source, "custom");
    assert_eq!(
        profile.font_family,
        format!("Fira Code, {}", full_fallback_stack())
    );
    // A family already in the fallback list is not repeated.
    let profile = detect(&fixture, "linux", Some("Menlo, monospace"), None);
    assert_eq!(
        profile.font_family,
        "Menlo, monospace, ui-monospace, SFMono-Regular, SF Mono, Monaco, Consolas, \
         Cascadia Mono, JetBrains Mono, MesloLGS NF, Hack Nerd Font, Noto Sans Mono CJK SC"
    );
    // A blank setting normalises to absent, so it is *not* a custom font.
    let profile = detect(&fixture, "linux", Some("   "), None);
    assert_eq!(profile.source, "fallback");
}

#[test]
fn inherit_off_skips_detection_entirely() {
    let fixture = Fixture::new("inherit-off");
    fixture.write(
        ".config/kitty/kitty.conf",
        "font_family Fira Code\nfont_size 12.0\n",
    );
    let profile = detect(&fixture, "linux", Some("Hack"), Some(false));
    assert_eq!(profile.source, "custom");
    assert_eq!(profile.font_size, None, "no detection ran, so no size crossed");
    assert_eq!(profile.theme, None);
}

#[test]
fn vscode_jsonc_and_strict_json_agree() {
    let jsonc = Fixture::new("vscode-jsonc");
    jsonc.write(
        ".config/Code/User/settings.json",
        "{\n  // the editor's own comment\n  \"terminal.integrated.fontFamily\": \"JetBrains Mono\",\n  /* and a block */\n}\n",
    );
    let strict = Fixture::new("vscode-strict");
    strict.write(
        ".config/Code/User/settings.json",
        "{\n  \"terminal.integrated.fontFamily\": \"JetBrains Mono\"\n}\n",
    );
    let from_jsonc = detect(&jsonc, "linux", None, None);
    let from_strict = detect(&strict, "linux", None, None);
    assert_eq!(from_jsonc, from_strict);
    assert_eq!(from_jsonc.source, "system");
    assert!(from_jsonc
        .font_family
        .starts_with("JetBrains Mono, ui-monospace"));
}

#[test]
fn vscode_without_the_key_falls_through_to_fallback() {
    let fixture = Fixture::new("vscode-missing");
    fixture.write(
        ".config/Code/User/settings.json",
        "{ \"editor.fontSize\": 13 }",
    );
    assert_eq!(detect(&fixture, "linux", None, None).source, "fallback");
}

#[test]
fn windows_terminal_prefers_the_default_profile_guid() {
    let fixture = Fixture::new("wt-guid");
    fixture.write(
        "AppData/Local/Microsoft/Windows Terminal/settings.json",
        r#"{
          "defaultProfile": "{guid-2}",
          "profiles": { "list": [
            { "guid": "{guid-1}", "font": { "face": "Cascadia Code" } },
            { "guid": "{guid-2}", "font": { "face": "Consolas" } }
          ] }
        }"#,
    );
    let profile = detect_windows(&fixture, None, None);
    assert!(
        profile.font_family.starts_with("Consolas, "),
        "got {}",
        profile.font_family
    );
    // The same file is invisible off win32, because the detector is platform-gated.
    assert_eq!(detect(&fixture, "linux", None, None).source, "fallback");
}

#[test]
fn windows_terminal_falls_back_to_defaults_then_to_the_first_entry() {
    let defaults = Fixture::new("wt-defaults");
    defaults.write(
        "AppData/Local/Microsoft/Windows Terminal/settings.json",
        r#"{
          "defaultProfile": "{nope}",
          "profiles": {
            "defaults": { "font": { "face": "Cascadia Mono" } },
            "list": [ { "font": { "face": "Lucida Console" } } ]
          }
        }"#,
    );
    assert!(detect_windows(&defaults, None, None)
        .font_family
        .starts_with("Cascadia Mono, "));

    let first = Fixture::new("wt-first");
    first.write(
        "AppData/Local/Microsoft/Windows Terminal/settings.json",
        r#"{ "profiles": { "list": [
            { "name": "no font" },
            { "font": { "face": "Lucida Console" } }
        ] } }"#,
    );
    assert!(detect_windows(&first, None, None)
        .font_family
        .starts_with("Lucida Console, "));
}

#[test]
fn windows_terminal_needs_an_app_data_directory() {
    let fixture = Fixture::new("wt-no-appdata");
    fixture.write(
        "AppData/Local/Microsoft/Windows Terminal/settings.json",
        r#"{ "profiles": { "defaults": { "font": { "face": "Consolas" } } } }"#,
    );
    // `LOCALAPPDATA` and `APPDATA` are both absent, so the detector cannot even build a path.
    let env = env_for(&fixture.home());
    let profile = resolve_terminal_font_profile("win32", &env, None, None, None, None);
    assert_eq!(profile.source, "fallback");
}

#[test]
fn kitty_reads_a_quoted_family_and_strips_both_quotes() {
    let fixture = Fixture::new("kitty-quoted");
    fixture.write(".config/kitty/kitty.conf", "font_family  \"Fira Code\"\n");
    let profile = detect(&fixture, "linux", None, None);
    assert!(profile.font_family.starts_with("Fira Code, "));
}

#[test]
fn kitty_takes_the_first_matching_line_even_when_it_is_blank() {
    let fixture = Fixture::new("kitty-blank-first");
    fixture.write(
        ".config/kitty/kitty.conf",
        "font_family   \nfont_family  MesloLGS NF\n",
    );
    // The regex's `\s+` swallows the newline after the blank value, so the capture is the
    // *next* line's text — key included. Reproduced verbatim; the user sees a nonsense font
    // name, which is what they saw before the port.
    let profile = detect(&fixture, "linux", None, None);
    assert_eq!(profile.source, "system");
    assert!(profile
        .font_family
        .starts_with("font_family  MesloLGS NF, ui-monospace"));
}

#[test]
fn kitty_wins_over_alacritty() {
    let fixture = Fixture::new("precedence");
    fixture.write(".config/kitty/kitty.conf", "font_family Hack\n");
    fixture.write(
        ".config/alacritty/alacritty.toml",
        "[font.normal]\nfamily = \"Iosevka\"\n",
    );
    assert!(detect(&fixture, "linux", None, None)
        .font_family
        .starts_with("Hack, "));
}

#[test]
fn alacritty_reads_toml_and_yaml() {
    let toml = Fixture::new("alacritty-toml");
    toml.write(
        ".config/alacritty/alacritty.toml",
        "[font.normal]\nfamily = \"Iosevka\"\n",
    );
    assert!(detect(&toml, "linux", None, None)
        .font_family
        .starts_with("Iosevka, "));

    let yaml = Fixture::new("alacritty-yaml");
    yaml.write(
        ".config/alacritty/alacritty.yml",
        "font:\n  normal:\n    family: Berkeley Mono\n",
    );
    assert!(detect(&yaml, "linux", None, None)
        .font_family
        .starts_with("Berkeley Mono, "));
}

#[test]
fn alacritty_rejects_a_multi_document_stream_and_a_non_string_family() {
    let multi = Fixture::new("alacritty-multidoc");
    multi.write(
        ".config/alacritty/alacritty.yaml",
        "font:\n  normal:\n    family: One\n---\nfont:\n  normal:\n    family: Two\n",
    );
    assert_eq!(detect(&multi, "linux", None, None).source, "fallback");

    let numeric = Fixture::new("alacritty-numeric");
    numeric.write(
        ".config/alacritty/alacritty.toml",
        "[font.normal]\nfamily = 42\n",
    );
    assert_eq!(detect(&numeric, "linux", None, None).source, "fallback");
}

#[test]
fn a_malformed_config_file_does_not_break_the_ladder() {
    let fixture = Fixture::new("malformed");
    fixture.write(".config/Code/User/settings.json", "{ this is not json");
    fixture.write(".config/kitty/kitty.conf", "font_family Hack\n");
    // The broken VS Code file yields nothing and the ladder continues to kitty.
    assert!(detect(&fixture, "linux", None, None)
        .font_family
        .starts_with("Hack, "));
}

#[test]
fn the_macos_plists_are_injected_by_the_caller() {
    let fixture = Fixture::new("macos");
    let env = env_for(&fixture.home());
    let iterm2 = json(
        r##"{"New Bookmarks":[
             {"Normal Font":"Ignored 10"},
             {"Normal Font":"SFMono-Regular 12","Default Bookmark":true,
              "Foreground Color":"#c0c0c0",
              "Ansi 0 Color":{"Red Component":0.1,"Green Component":0.2,"Blue Component":0.3},
              "Ansi 1 Color":{"Red Component":0.5,"Green Component":0.5,"Blue Component":0.5,
                              "Alpha Component":0.5}}
           ]}"##,
    );
    let macos = json(
        r#"{"Startup Window Settings":"Basic",
            "Default Window Settings":"Pro",
            "Basic":{"FontName":"Andale Mono","FontSize":13},
            "Pro":{"FontName":"Pro Font","FontSize":15}}"#,
    );
    let profile = resolve_terminal_font_profile("darwin", &env, None, None, Some(&iterm2), Some(&macos));
    assert_eq!(profile.source, "system");
    assert!(profile.font_family.starts_with("SFMono Regular, "));
    assert_eq!(profile.font_size, Some(12.0));
    let theme = profile.theme.unwrap();
    assert_eq!(theme.foreground.as_deref(), Some("#c0c0c0"));
    assert_eq!(theme.black.as_deref(), Some("#1a334d"));
    assert_eq!(theme.red.as_deref(), Some("rgba(128, 128, 128, 0.5)"));

    // Without an iTerm2 profile, the macOS Terminal one is used, and the startup settings
    // win over the default settings.
    let empty_iterm2 = json(r#"{"New Bookmarks":[]}"#);
    let profile =
        resolve_terminal_font_profile("darwin", &env, None, None, Some(&empty_iterm2), Some(&macos));
    assert!(profile.font_family.starts_with("Andale Mono, "));
    assert_eq!(profile.font_size, Some(13.0));

    // Off darwin neither macOS detector runs.
    let profile =
        resolve_terminal_font_profile("linux", &env, None, None, Some(&iterm2), Some(&macos));
    assert_eq!(profile.source, "fallback");
}

#[test]
fn a_colours_only_macos_profile_survives_without_a_font_family() {
    let fixture = Fixture::new("macos-colours-only");
    let env = env_for(&fixture.home());
    let macos = json(
        r#"{"Startup Window Settings":"Basic",
            "Basic":{"FontSize":14,"TextColor":{"Red Component":1,"Green Component":1,"Blue Component":1}}}"#,
    );
    let profile = resolve_terminal_font_profile("darwin", &env, None, None, None, Some(&macos));
    assert_eq!(profile.source, "system");
    // No family detected, so the first fallback leads the stack.
    assert!(profile.font_family.starts_with("ui-monospace, "));
    assert_eq!(profile.font_size, Some(14.0));
    assert_eq!(
        profile.theme.unwrap().foreground.as_deref(),
        Some("#ffffff")
    );

    // And a custom family keeps the detected colours and size.
    let profile =
        resolve_terminal_font_profile("darwin", &env, Some("Fira Code"), None, None, Some(&macos));
    assert_eq!(profile.source, "custom");
    assert_eq!(profile.font_size, Some(14.0));
    assert!(profile.theme.is_some());
}
