//! The TS↔Rust boundary types.
//!
//! Field order is load-bearing twice over: `#[napi(object)]` sets properties in declaration
//! order, so the order here is the key order of the emitted JavaScript object and therefore
//! the order `JSON.stringify` produces on the way to the renderer. The order below is the
//! *assignment* order of the legacy readers (`readIterm2Theme` writes
//! `foreground → background → cursor → cursorAccent → selectionBackground`, then the sixteen
//! ANSI keys), not the declaration order of the TypeScript interface, so the emitted payload
//! keeps the legacy byte order.

use napi_derive::napi;

/// `TerminalThemeProfile` (`packages/services/src/terminal/terminalProfileTypes.ts:3`).
#[napi(object)]
#[derive(Debug, Default, Clone, PartialEq)]
pub struct TerminalThemeProfile {
  #[napi(js_name = "foreground")]
  pub foreground: Option<String>,
  #[napi(js_name = "background")]
  pub background: Option<String>,
  #[napi(js_name = "cursor")]
  pub cursor: Option<String>,
  #[napi(js_name = "cursorAccent")]
  pub cursor_accent: Option<String>,
  #[napi(js_name = "selectionBackground")]
  pub selection_background: Option<String>,
  #[napi(js_name = "selectionInactiveBackground")]
  pub selection_inactive_background: Option<String>,
  #[napi(js_name = "black")]
  pub black: Option<String>,
  #[napi(js_name = "red")]
  pub red: Option<String>,
  #[napi(js_name = "green")]
  pub green: Option<String>,
  #[napi(js_name = "yellow")]
  pub yellow: Option<String>,
  #[napi(js_name = "blue")]
  pub blue: Option<String>,
  #[napi(js_name = "magenta")]
  pub magenta: Option<String>,
  #[napi(js_name = "cyan")]
  pub cyan: Option<String>,
  #[napi(js_name = "white")]
  pub white: Option<String>,
  #[napi(js_name = "brightBlack")]
  pub bright_black: Option<String>,
  #[napi(js_name = "brightRed")]
  pub bright_red: Option<String>,
  #[napi(js_name = "brightGreen")]
  pub bright_green: Option<String>,
  #[napi(js_name = "brightYellow")]
  pub bright_yellow: Option<String>,
  #[napi(js_name = "brightBlue")]
  pub bright_blue: Option<String>,
  #[napi(js_name = "brightMagenta")]
  pub bright_magenta: Option<String>,
  #[napi(js_name = "brightCyan")]
  pub bright_cyan: Option<String>,
  #[napi(js_name = "brightWhite")]
  pub bright_white: Option<String>,
}

impl TerminalThemeProfile {
  /// `compactTheme`: an empty theme is `undefined`, not `{}`.
  pub fn compact(self) -> Option<Self> {
    if self == Self::default() {
      None
    } else {
      Some(self)
    }
  }
}

/// `TerminalDetectedProfile` (`terminalProfileTypes.ts:28`).
#[napi(object)]
#[derive(Debug, Default, Clone, PartialEq)]
pub struct TerminalDetectedProfile {
  #[napi(js_name = "fontFamily")]
  pub font_family: Option<String>,
  #[napi(js_name = "fontSize")]
  pub font_size: Option<f64>,
  pub theme: Option<TerminalThemeProfile>,
}

impl TerminalDetectedProfile {
  /// `hasDetectedProfile` / `normalizeDetectedProfile`: a profile with no family, no size and
  /// no theme is nothing at all, and the ladder moves on.
  pub fn is_empty(&self) -> bool {
    self.font_family.is_none() && self.font_size.is_none() && self.theme.is_none()
  }

  /// `normalizeDetectedProfile`: `Some` only when something was actually detected.
  pub fn normalized(self) -> Option<Self> {
    if self.is_empty() {
      None
    } else {
      Some(self)
    }
  }
}

/// The result of `resolveTerminalFontProfile` (`terminalProfile.ts:15-20`).
#[napi(object)]
#[derive(Debug, Clone, PartialEq)]
pub struct TerminalFontProfile {
  #[napi(js_name = "fontFamily")]
  pub font_family: String,
  #[napi(js_name = "fontSize")]
  pub font_size: Option<f64>,
  pub theme: Option<TerminalThemeProfile>,
  /// `"custom" | "system" | "fallback"` — `TerminalFontFamilySource`.
  pub source: String,
}

/// The eight environment variables the detection and shell ladders read.
///
/// Projecting named variables instead of shipping `process.env` keeps the crate's inputs
/// typed and the boundary cost proportional to what is actually used.
#[napi(object)]
#[derive(Debug, Default, Clone)]
pub struct TerminalEnvInput {
  /// `env.HOME`
  pub home: Option<String>,
  /// `env.USERPROFILE`
  pub user_profile: Option<String>,
  /// `env.LOCALAPPDATA`
  pub local_app_data: Option<String>,
  /// `env.APPDATA`
  pub app_data: Option<String>,
  /// `env.XDG_CONFIG_HOME`
  pub xdg_config_home: Option<String>,
  /// `env.SHELL`
  pub shell: Option<String>,
  /// `env.PATH`
  pub path: Option<String>,
  /// `env.ComSpec`
  pub com_spec: Option<String>,
  /// `os.homedir()` — the last fallback of the home chain. Passed in rather than read here
  /// so the `HOME → USERPROFILE → homedir()` order is byte-identical without pulling in a
  /// `dirs`/`home` dependency for one `getpwuid`.
  pub home_dir: String,
}

impl TerminalEnvInput {
  /// `env.X?.trim() || fallback` — the legacy `?.trim()` + `||` idiom, where an empty or
  /// all-whitespace value is falsy and falls through.
  pub fn trimmed_or<'a>(value: Option<&'a str>, fallback: &'a str) -> &'a str {
    match value {
      Some(raw) => {
        let trimmed = crate::jsval::js_trim(raw);
        if trimmed.is_empty() {
          fallback
        } else {
          trimmed
        }
      }
      None => fallback,
    }
  }

  /// `resolveHomeDir`: `HOME` → `USERPROFILE` → `os.homedir()`, each trimmed, each skipped
  /// when blank.
  pub fn home_dir(&self) -> &str {
    let from_env = Self::trimmed_or(self.home.as_deref(), "");
    if !from_env.is_empty() {
      return from_env;
    }
    let from_profile = Self::trimmed_or(self.user_profile.as_deref(), "");
    if !from_profile.is_empty() {
      return from_profile;
    }
    &self.home_dir
  }
}
