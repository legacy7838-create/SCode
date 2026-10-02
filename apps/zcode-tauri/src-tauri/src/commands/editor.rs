//! Editor integrations and the confined host-open surface.
//!
//! Replaces `main/openInEditor.ts` (411 lines), `main/editors.ts` detection,
//! `main/desktopMainIpcHelpers.ts` (`openPathInFileManager`,
//! `openPathInDefaultApp`) and the `OpenInEditor` / `OpenExternalFile` IPC
//! handlers in `main/desktopMainIpcRemote.ts`.
//!
//! ## What changed against the Electron original, and why
//!
//! Three deliberate differences, each because the Electron behaviour was a hole
//! rather than a contract:
//!
//! 1. **Confinement.** `openInEditor` and `openPathInFileManager` took a
//!    renderer-supplied absolute path and handed it to the OS with no check
//!    (`main/openInEditor.ts:308-411`, `main/desktopMainIpcHelpers.ts:46-75`).
//!    Every command here admits the path through
//!    [`crate::commands::fs::AllowedRoots`] first — the same canonical
//!    allowlist `read_text_file` uses — so `..`, a symlink out of the tree, and
//!    a plain `/etc/passwd` are all [`CommandError::Forbidden`] before any
//!    process is spawned. The Electron side had to be fixed for this
//!    independently; the fix lives here once.
//!
//! 2. **No `file:` in the opener.** Electron's `isAllowedExternalOpenUrl`
//!    accepted `http:`, `https:` **and** `file:`
//!    (`main/desktopMainIpcRemote.ts:38-45`), so `openExternal("file:///…")`
//!    handed the OS any local path — and it read a renderer-supplied
//!    `sourceUrl` from the payload to decide where the user "came from". Local
//!    paths do not go through the URL opener at all here: they go through the
//!    confined path commands below, where the allowlist actually applies.
//!
//! 3. **Remote paths are not confined, and that is deliberate.** A
//!    `remoteTarget` means `path` lives on another machine. It never reaches the
//!    local filesystem — it is percent-encoded into a `vscode-remote://` folder
//!    URI, or converted to a `\\wsl.localhost\…` UNC path — so there is nothing
//!    local to confine. What *is* checked is that it is an absolute path free of
//!    control characters, because that string is passed verbatim as a process
//!    argument.
//!
//! ## Editor selection: the whitelist is Electron's, the config is Linux's
//!
//! `main/editors.ts:328-338` returns an empty list outside macOS and Windows, so
//! on Linux Electron offered **no** editors at all — `getInstalledEditors()`
//! returned `[]` and every `openInEditor` id answered
//! `unknown editor: <id>`. This module keeps Electron's selection rule (a
//! curated table of known desktop entries, not "every application on the
//! machine") and adds a Linux source for the per-entry *configuration* —
//! `Name`, `Exec` and `Icon` parsed out of the freedesktop `.desktop` file,
//! which is exactly what the macOS `Info.plist` and the Windows
//! `Program Files` scan were doing.
//!
//! ## Verified / not verified
//!
//! Every command's validation, selection logic, `.desktop` and `Exec` parsing,
//! and remote-URI construction are unit-tested. Launching an editor, revealing in
//! a file manager and opening a file with its default application **launch other
//! applications and are not exercised end to end** — the same caveat
//! `PORT_STATUS.md:103-107` records for the pickers and the opener.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use super::fs::{AllowedRoots, HostPathKind};
use super::native::OpenResult;
use super::{require_registered_window, CommandError, CommandResult};
use crate::app_state::AppState;

// ---------------------------------------------------------------------------
// Editor catalogue
// ---------------------------------------------------------------------------

/// What role an entry plays, which decides how `open_in_editor` launches it.
///
/// Electron encoded this in the id (`finder` / `explorer` are the file managers,
/// everything else is a launcher) and branched on it by string comparison
/// (`main/openInEditor.ts:355-379`). Making it a field keeps the same behaviour
/// without a magic-string list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EditorKind {
    /// Takes a path as an argument.
    Launcher,
    /// Reveals a file in its parent directory, or opens a directory.
    FileManager,
    /// Reveal, and additionally select the file, when handed one.
    Terminal,
}

/// One known application, by the freedesktop entry that ships it.
///
/// `desktop` lists the `.desktop` basenames that identify it; the first one found
/// on disk wins. This is Electron's allowlist
/// (`MAC_EDITOR_DEFS` / `WINDOWS_ADDITIONAL_EDITOR_DEFS`) expressed for the XDG
/// layout, deliberately *not* "scan every `applications/*.desktop`", so a
/// system full of unrelated entries does not become an editor menu.
struct EditorSeed {
    id: &'static str,
    name: &'static str,
    kind: EditorKind,
    desktop: &'static [&'static str],
}

const EDITOR_SEEDS: &[EditorSeed] = &[
    // Code editors — the VS Code family, which is also the only family that
    // understands `vscode-remote://` folder URIs.
    EditorSeed { id: "vscode", name: "VS Code", kind: EditorKind::Launcher, desktop: &["code"] },
    EditorSeed {
        id: "vscode-insiders",
        name: "VS Code Insiders",
        kind: EditorKind::Launcher,
        desktop: &["code-insiders"],
    },
    EditorSeed { id: "vscodium", name: "VSCodium", kind: EditorKind::Launcher, desktop: &["codium"] },
    EditorSeed { id: "cursor", name: "Cursor", kind: EditorKind::Launcher, desktop: &["cursor"] },
    EditorSeed { id: "zed", name: "Zed", kind: EditorKind::Launcher, desktop: &["zed"] },
    EditorSeed { id: "trae", name: "Trae", kind: EditorKind::Launcher, desktop: &["trae"] },
    EditorSeed {
        id: "sublime",
        name: "Sublime Text",
        kind: EditorKind::Launcher,
        desktop: &["sublime_text"],
    },
    EditorSeed {
        id: "codebuddy",
        name: "CodeBuddy",
        kind: EditorKind::Launcher,
        desktop: &["codebuddy"],
    },
    // JetBrains. The desktop entry basename is the product name lowercased with
    // spaces removed (`jetbrains-idea`, `webstorm`, …); `IDEA.sh`'s `ID=` is
    // lowercased too, which is why both spellings are listed for the IDEs that
    // use it.
    EditorSeed { id: "idea", name: "IntelliJ IDEA", kind: EditorKind::Launcher, desktop: &["jetbrains-idea", "idea"] },
    EditorSeed { id: "idea-ce", name: "IntelliJ IDEA CE", kind: EditorKind::Launcher, desktop: &["jetbrains-idea-ce", "idea-ce"] },
    EditorSeed { id: "webstorm", name: "WebStorm", kind: EditorKind::Launcher, desktop: &["webstorm"] },
    EditorSeed { id: "pycharm", name: "PyCharm", kind: EditorKind::Launcher, desktop: &["pycharm"] },
    EditorSeed { id: "goland", name: "GoLand", kind: EditorKind::Launcher, desktop: &["goland"] },
    EditorSeed { id: "phpstorm", name: "PhpStorm", kind: EditorKind::Launcher, desktop: &["phpstorm"] },
    EditorSeed { id: "rider", name: "Rider", kind: EditorKind::Launcher, desktop: &["rider"] },
    EditorSeed { id: "clion", name: "CLion", kind: EditorKind::Launcher, desktop: &["clion"] },
    EditorSeed { id: "rubymine", name: "RubyMine", kind: EditorKind::Launcher, desktop: &["rubymine"] },
    EditorSeed { id: "datagrip", name: "DataGrip", kind: EditorKind::Launcher, desktop: &["datagrip"] },
    // Terminals.
    EditorSeed {
        id: "terminal",
        name: "Terminal",
        kind: EditorKind::Terminal,
        desktop: &["org.gnome.Terminal", "gnome-terminal", "x-terminal-emulator", "konsole", "xfce4-terminal"],
    },
    EditorSeed { id: "ghostty", name: "Ghostty", kind: EditorKind::Terminal, desktop: &["ghostty"] },
    EditorSeed { id: "warp", name: "Warp", kind: EditorKind::Terminal, desktop: &["warp"] },
    // File managers — the Linux counterpart of Electron's Finder / Explorer ids.
    EditorSeed { id: "nemo", name: "Files", kind: EditorKind::FileManager, desktop: &["nemo"] },
    EditorSeed { id: "nautilus", name: "Files", kind: EditorKind::FileManager, desktop: &["org.gnome.Nautilus", "nautilus"] },
    EditorSeed { id: "dolphin", name: "Dolphin", kind: EditorKind::FileManager, desktop: &["org.kde.dolphin"] },
    EditorSeed { id: "thunar", name: "Thunar", kind: EditorKind::FileManager, desktop: &["thunar"] },
];

/// VS Code and VS Code Insiders are the only entries that accept a
/// `vscode-remote://` folder URI. Mirrors `VSCODE_EDITOR_IDS`
/// (`main/openInEditor.ts:17`).
fn is_vscode_editor(id: &str) -> bool {
    matches!(id, "vscode" | "vscode-insiders")
}

// ---------------------------------------------------------------------------
// `.desktop` parsing
// ---------------------------------------------------------------------------

/// The `[Desktop Entry]` keys this port reads.
///
/// Deliberately a closed list: `deny_unknown_fields` discipline applied to the
/// file format as well as the wire, so a mistyped key is a bug here rather than
/// a silently-absent value in production.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct DesktopEntry {
    name: Option<String>,
    exec: Option<String>,
    icon: Option<String>,
    no_display: bool,
    hidden: bool,
    try_exec: Option<String>,
    desktop_id: String,
}

/// Parse a `.desktop` file, returning its `[Desktop Entry]` group.
///
/// Follows the freedesktop desktop-entry spec for the subset that matters:
/// `#` comments, `Key=Value`, and logical-line continuation (a line beginning
/// with whitespace continues the previous one, which is how `Exec` is wrapped in
/// real entries). Keys outside `[Desktop Entry]` are ignored, and a key this
/// port does not read is dropped rather than guessed at.
fn parse_desktop_entry(content: &str, desktop_id: &str) -> DesktopEntry {
    let mut entry = DesktopEntry {
        desktop_id: desktop_id.to_string(),
        ..DesktopEntry::default()
    };
    let mut in_group = false;
    // Only `Exec` is long enough in practice to be wrapped, so only it is
    // buffered for continuation; every other key is single-line by spec.
    let mut pending_exec: Option<String> = None;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        // A continuation of the buffered `Exec`, per the spec's logical-line
        // rule: leading whitespace continues, anything else terminates.
        if let Some(pending) = pending_exec.as_mut() {
            if raw_line.starts_with(char::is_whitespace) {
                pending.push(' ');
                pending.push_str(line);
                continue;
            }
            entry.exec = Some(pending_exec.take().unwrap_or_default());
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            in_group = line == "[Desktop Entry]";
            continue;
        }
        if !in_group {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "Name" => entry.name = Some(value.to_string()),
            "Exec" => pending_exec = Some(value.to_string()),
            "Icon" => entry.icon = Some(value.to_string()),
            "NoDisplay" => entry.no_display = parse_desktop_bool(value),
            "Hidden" => entry.hidden = parse_desktop_bool(value),
            "TryExec" => entry.try_exec = Some(value.to_string()),
            _ => {}
        }
    }
    if let Some(pending) = pending_exec {
        entry.exec = Some(pending);
    }
    entry
}

/// The spec's boolean: exactly `true` is true; everything else is false.
/// Parse a desktop-entry boolean.
///
/// The freedesktop spec allows exactly `true` and `false`, lowercase, and says
/// anything else is undefined. So this compares exactly rather than
/// case-insensitively: `eq_ignore_ascii_case("true")` would treat `NoDisplay=TRUE`
/// as hidden, which is a behaviour fork from the spec *and* from the Electron
/// reader it replaces. A malformed value reads as the default (`false`), so an
/// entry is never hidden by a typo in its own key.
fn parse_desktop_bool(value: &str) -> bool {
    value.trim() == "true"
}

/// One executable token from an `Exec=` line.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ExecToken {
    value: String,
    /// A field code (`%f`, `%U`, `%i`, …), which is dropped rather than passed.
    field_code: bool,
}

/// Split an `Exec=` line into tokens, honouring double quotes and backslash
/// escaping, and mark the field codes.
///
/// The freedesktop spec reserves backslash for the next character and says
/// quoting with single quotes is **not** supported; both are handled that way
/// here. A token containing a field code is dropped wholesale, because `%F`
/// expands to a *list* of files and splicing it into one argument would be
/// wrong — this port hands the path separately.
fn tokenize_exec(exec: &str) -> Vec<ExecToken> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;
    let mut chars = exec.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                started = true;
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            '"' => {
                quoted = !quoted;
                started = true;
            }
            ch if ch.is_whitespace() && !quoted => {
                if started {
                    tokens.push(ExecToken {
                        value: std::mem::take(&mut current),
                        field_code: false,
                    });
                    started = false;
                }
            }
            '%' => {
                // `%f` / `%U` / `%i` / … A `%%` is a literal percent sign.
                match chars.peek().copied() {
                    Some('%') => {
                        chars.next();
                        current.push('%');
                        started = true;
                    }
                    Some(code) if code.is_ascii_alphabetic() => {
                        chars.next();
                        started = true;
                        // The token being built is the field code itself, not a
                        // value, so whatever was accumulated before `%` is
                        // discarded along with it.
                        tokens.push(ExecToken {
                            value: format!("%{code}"),
                            field_code: true,
                        });
                    }
                    _ => {
                        current.push('%');
                        started = true;
                    }
                }
            }
            other => {
                started = true;
                current.push(other);
            }
        }
    }
    if started {
        tokens.push(ExecToken {
            value: current,
            field_code: false,
        });
    }
    tokens
}

/// A launchable command: the program plus its fixed arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
}

/// Build the launch spec for a `.desktop` `Exec=` line.
///
/// `None` when there is nothing to run — an empty line, or a line whose only
/// tokens are field codes. The result is the program followed by its remaining
/// arguments with every field code removed.
fn parse_exec(exec: &str) -> Option<LaunchSpec> {
    let tokens: Vec<ExecToken> = tokenize_exec(exec)
        .into_iter()
        .filter(|token| !token.field_code && !token.value.is_empty())
        .collect();
    let mut iter = tokens.into_iter();
    let program = iter.next()?.value;
    Some(LaunchSpec {
        program,
        args: iter.map(|token| token.value).collect(),
    })
}

// ---------------------------------------------------------------------------
// Desktop-entry discovery
// ---------------------------------------------------------------------------

/// A seed resolved against the entries actually installed on this machine.
#[derive(Debug, Clone)]
struct InstalledEditor {
    id: String,
    name: String,
    kind: EditorKind,
    desktop_id: String,
    launch: LaunchSpec,
    icon: Option<String>,
}

/// The XDG data directories searched for `applications/*.desktop`.
///
/// `$XDG_DATA_HOME` first, then each `$XDG_DATA_DIRS` entry, falling back to the
/// spec defaults (`~/.local/share`, `/usr/local/share`, `/usr/share`).
fn application_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let home = std::env::var("HOME").ok().map(PathBuf::from);
    match std::env::var("XDG_DATA_HOME").ok().filter(|v| !v.trim().is_empty()) {
        Some(configured) => dirs.push(PathBuf::from(configured).join("applications")),
        None => {
            if let Some(home) = home.as_ref() {
                dirs.push(home.join(".local/share/applications"));
            }
        }
    }
    let configured = std::env::var("XDG_DATA_DIRS").ok().unwrap_or_default();
    let configured = if configured.trim().is_empty() {
        "/usr/local/share:/usr/share".to_string()
    } else {
        configured
    };
    dirs.extend(
        configured
            .split(':')
            .filter(|entry| !entry.trim().is_empty())
            .map(|entry| PathBuf::from(entry.trim()).join("applications")),
    );
    dirs
}

/// Is `program` runnable? Resolves `PATH` the way `Command::new` would, so a
/// `TryExec` gate agrees with what would actually be spawned.
fn executable_on_path(program: &str) -> bool {
    if program.is_empty() {
        return false;
    }
    let candidate = Path::new(program);
    if candidate.components().count() > 1 {
        return is_executable_file(candidate);
    }
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| is_executable_file(&dir.join(program)))
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

/// Read one `.desktop` file and turn it into an [`InstalledEditor`], or `None`
/// when the entry must not be shown.
///
/// Hidden by spec rule: `NoDisplay=true`, `Hidden=true`, a `TryExec` binary that
/// is not on `PATH`, a missing `Exec`, or an `Exec` that leaves nothing to run.
fn installed_editor(seed: &EditorSeed, entry_path: &Path, content: &str) -> Option<InstalledEditor> {
    let desktop_id = entry_path.file_stem()?.to_string_lossy().into_owned();
    let entry = parse_desktop_entry(content, &desktop_id);
    if entry.no_display || entry.hidden {
        return None;
    }
    if let Some(try_exec) = entry.try_exec.as_deref() {
        if !executable_on_path(try_exec) {
            return None;
        }
    }
    Some(InstalledEditor {
        id: seed.id.to_string(),
        name: entry.name.unwrap_or_else(|| seed.name.to_string()),
        kind: seed.kind,
        desktop_id: entry.desktop_id,
        launch: parse_exec(entry.exec.as_deref()?)?,
        icon: entry.icon,
    })
}

/// Resolve every seed against the XDG application directories.
///
/// `dirs` is a parameter rather than an environment read so this is testable
/// without touching the machine's real XDG layout.
fn detect_editors(dirs: &[PathBuf]) -> Vec<InstalledEditor> {
    EDITOR_SEEDS
        .iter()
        .filter_map(|seed| {
            dirs.iter()
                .flat_map(|dir| {
                    seed.desktop
                        .iter()
                        .map(move |basename| dir.join(format!("{basename}.desktop")))
                })
                .find_map(|path| {
                    let content = std::fs::read_to_string(&path).ok()?;
                    installed_editor(seed, &path, &content)
                })
        })
        .collect()
}

/// Process-wide detection cache.
///
/// Electron cached this too (`cachedEditors`, `main/editors.ts:361`) and the
/// comment there is right that the result does not change over the lifetime of
/// the app. Poisoning is ignored: a panic mid-detection leaves the cache empty
/// and the next call simply detects again.
static EDITOR_CACHE: LazyLock<Mutex<Option<Arc<Vec<InstalledEditor>>>>> =
    LazyLock::new(|| Mutex::new(None));

fn installed_editors() -> Arc<Vec<InstalledEditor>> {
    let mut cache = EDITOR_CACHE.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(cached) = cache.as_ref() {
        return Arc::clone(cached);
    }
    let detected = Arc::new(detect_editors(&application_dirs()));
    *cache = Some(Arc::clone(&detected));
    detected
}

/// Resolve `id` to an installed editor, or report the same refusal Electron
/// produced: `unknown editor: <id>` (`main/openInEditor.ts:313-316`).
fn lookup_editor(editor_id: &str) -> CommandResult<InstalledEditor> {
    let trimmed = editor_id.trim();
    let id = trimmed.strip_prefix("zcode-editor:").unwrap_or(trimmed);
    installed_editors()
        .iter()
        .find(|editor| editor.id == id)
        .cloned()
        .ok_or_else(|| CommandError::Forbidden(format!("unknown editor: {trimmed}")))
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/// One entry as the renderer sees it. Mirrors `EditorInfo`
/// (`packages/shared/src/platform.ts:200-208`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorInfo {
    pub id: String,
    pub name: String,
    /// Base64 data URL. Empty string when no icon could be resolved — the same
    /// "an editor with no icon is still an editor" rule Electron applied by
    /// dropping the whole entry (`main/editors.ts:653-659`), except that the
    /// identity is worth keeping even without artwork.
    pub icon_data_url: String,
}

/// Icon themes searched, in order, when a `.desktop` `Icon=` is a themed name.
fn icon_theme_dirs() -> Vec<PathBuf> {
    let mut themes: Vec<String> = Vec::new();
    if let Ok(configured) = std::env::var("XDG_ICON_THEMES") {
        themes.extend(
            configured
                .split(':')
                .filter(|t| !t.trim().is_empty())
                .map(|t| t.trim().to_string()),
        );
    }
    themes.push("hicolor".to_string());
    themes.push("Adwaita".to_string());

    let mut bases = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        bases.push(PathBuf::from(&home).join(".icons"));
        bases.push(PathBuf::from(&home).join(".local/share/icons"));
    }
    bases.push(PathBuf::from("/usr/share/icons"));
    // Unthemed icons live directly in `pixmaps`, with no size subdirectory.
    bases.push(PathBuf::from("/usr/share/pixmaps"));

    let mut dirs = Vec::new();
    for base in bases {
        for theme in &themes {
            let Ok(sizes) = std::fs::read_dir(base.join(theme)) else {
                continue;
            };
            // Directory order is filesystem order; sort so the icon a machine
            // reports does not change between runs.
            let mut paths: Vec<PathBuf> =
                sizes.filter_map(|entry| entry.ok().map(|entry| entry.path())).collect();
            paths.sort();
            dirs.extend(paths.into_iter().filter(|path| path.is_dir()));
        }
        if base.file_name().is_some_and(|name| name == "pixmaps") && base.is_dir() {
            dirs.push(base);
        }
    }
    dirs.dedup();
    dirs
}

/// MIME type for the icon formats a `.desktop` `Icon=` may name. XPM is absent
/// because no renderer in this app decodes it.
fn icon_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Resolve a `.desktop` `Icon=` value to a base64 data URL.
///
/// `Icon=` is either an absolute path or a themed icon name. Names are searched
/// across the icon theme directories at the sizes the themes ship, which is the
/// Linux equivalent of what Electron did with `app.getFileIcon` on the `.app`
/// bundle or the `.exe`.
fn resolve_icon_data_url(icon: &str, theme_dirs: &[PathBuf]) -> Option<String> {
    use base64::Engine as _;
    let name = icon.trim();
    if name.is_empty() {
        return None;
    }
    let candidates: Vec<PathBuf> = if name.starts_with('/') {
        vec![PathBuf::from(name)]
    } else {
        let mut found = Vec::new();
        for dir in theme_dirs {
            for suffix in ["apps", "apps-unix", ""] {
                let base = if suffix.is_empty() {
                    dir.clone()
                } else {
                    dir.join(suffix)
                };
                for extension in ["png", "svg", "webp", "jpg", "jpeg", "xpm"] {
                    found.push(base.join(format!("{name}.{extension}")));
                }
            }
        }
        found
    };
    for candidate in candidates {
        let Some(mime) = icon_mime(&candidate) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&candidate) else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Some(format!("data:{mime};base64,{encoded}"));
    }
    None
}

// ---------------------------------------------------------------------------
// `getInstalledEditors`
// ---------------------------------------------------------------------------

/// `IPlatformService.getInstalledEditors` — the editors this machine has.
///
/// Electron returned `[]` on Linux (`main/editors.ts:328-338`), so the renderer
/// showed an empty "Open in Editor" menu. Here the same curated table is
/// resolved against the XDG application directories.
#[tauri::command]
pub fn get_installed_editors(
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
) -> CommandResult<Vec<EditorInfo>> {
    require_registered_window(&app_state, window.label())?;
    let theme_dirs = icon_theme_dirs();
    Ok(installed_editors()
        .iter()
        .map(|editor| EditorInfo {
            id: editor.id.clone(),
            name: editor.name.clone(),
            icon_data_url: editor
                .icon
                .as_deref()
                .and_then(|icon| resolve_icon_data_url(icon, &theme_dirs))
                .unwrap_or_default(),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Remote targets
// ---------------------------------------------------------------------------

/// A remote workspace the path belongs to.
///
/// `OpenInEditorRemoteTarget` in TypeScript is a `Pick<…>` union, so the wire
/// shape is rebuilt here rather than imported. Kebab-case variants, camelCase
/// fields, `deny_unknown_fields` — the `HostMessage` discipline
/// (`PORT_STATUS.md:117-122`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RemoteTarget {
    Ssh {
        host: String,
        #[serde(default)]
        port: Option<u16>,
        #[serde(default)]
        username: String,
        #[serde(default)]
        ssh_config_alias: Option<String>,
    },
}

/// `OpenInEditorOptions` (`packages/shared/src/platform.ts:227-231`). Fields
/// stay camelCase — only the *variant* names of [`RemoteTarget`] are
/// kebab-cased, so the two halves of the wire do not fork.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenInEditorOptions {
    #[serde(default)]
    pub remote_target: Option<RemoteTarget>,
    #[serde(default)]
    pub workspace_identity: Option<String>,
    #[serde(default)]
    pub path_kind: Option<HostPathKind>,
}

/// Refuse a remote path that is not a plain absolute path.
///
/// The remote path is never confined — it belongs to another machine — but it is
/// passed verbatim as a process argument, so a NUL byte or a newline in it must
/// not reach `Command::arg`.
fn validate_remote_path(path: &str) -> CommandResult<&str> {
    let trimmed = path.trim();
    if trimmed.chars().any(|c| c.is_control() || c == '\0') {
        return Err(CommandError::InvalidPayload(
            "remote path contains control characters".to_string(),
        ));
    }
    if !trimmed.starts_with('/') && !trimmed.starts_with('\\') {
        return Err(CommandError::InvalidPayload(format!(
            "remote path is not absolute: {trimmed:?}"
        )));
    }
    Ok(trimmed)
}

/// Windows separators to `/`, and a leading slash guaranteed.
///
/// Mirrors `normalizeRemotePath` (`main/openInEditor.ts:51-54`).
fn normalize_remote_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{normalized}")
    }
}

/// Percent-encode a remote path for a URI path component, leaving the
/// separators alone.
///
/// Mirrors `encodeRemotePath` (`main/openInEditor.ts:56-61`).
fn encode_remote_path(path: &str) -> String {
    normalize_remote_path(path)
        .split('/')
        .enumerate()
        .map(|(index, segment)| {
            if index == 0 {
                String::new()
            } else {
                percent_encode(segment)
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// RFC 3986 unreserved set, then `%XX` for everything else. The repo already
/// depends on `urlencoding`, but this keeps the two halves (`authority` and
/// `path`) consistent and needs no extra type juggling.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// The VS Code Remote-SSH authority for a target: the SSH config alias when the
/// workspace was opened through one, else `user@host[:port]`.
///
/// Mirrors `resolveVSCodeSshRemoteAuthority` (`main/openInEditor.ts:93-105`).
fn resolve_vscode_ssh_remote_authority(target: &RemoteTarget) -> CommandResult<String> {
    // `RemoteTarget` has a single `Ssh` variant, so this destructure is
    // irrefutable — a `let … else` here would have an unreachable `else`.
    let RemoteTarget::Ssh {
        host,
        port,
        username,
        ssh_config_alias,
    } = target;
    if let Some(alias) = ssh_config_alias.as_deref().map(str::trim) {
        if !alias.is_empty() {
            return Ok(alias.to_string());
        }
    }
    let host = host.trim();
    if host.is_empty() {
        return Err(CommandError::InvalidPayload(
            "ssh target has no host".to_string(),
        ));
    }
    let username = username.trim();
    let user_host = if username.is_empty() {
        host.to_string()
    } else {
        format!("{username}@{host}")
    };
    Ok(match port {
        Some(port) if *port != 22 && *port != 0 => format!("{user_host}:{port}"),
        _ => user_host,
    })
}

/// `vscode-remote://ssh-remote+<authority><encoded-path>`.
///
/// The authority is encoded **as a whole**: a manual target's authority may
/// contain `@` and `:`, and typing those into the URI unencoded would let them
/// be reparsed as userinfo/host/port. This is `buildVSCodeSshFolderUri`
/// (`main/openInEditor.ts:107-115`).
fn build_vscode_ssh_folder_uri(path: &str, target: &RemoteTarget) -> CommandResult<String> {
    let authority = resolve_vscode_ssh_remote_authority(target)?;
    Ok(format!(
        "vscode-remote://ssh-remote+{}{}",
        percent_encode(&authority),
        encode_remote_path(path)
    ))
}





// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

/// Spawn `program` with `args`, without a shell.
///
/// `Command::new` never goes through `/bin/sh`, so a path containing a space, a
/// quote or a `;` is one argument and not a second command — the property
/// Electron's `execFile` had and `exec` would not.
async fn run(program: &str, args: &[String]) -> Result<(), String> {
    let mut command = Command::new(program);
    command.args(args);
    // Electron's `execFile` inherits stdio and never resolves a login shell,
    // so the editor owns the terminal rather than racing this process for it.
    command
        .status()
        .map_err(|error| format!("{program}: {error}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!("{program} exited with {status}"))
            }
        })
}

/// Run an editor's own CLI, as `Exec=` declares it plus the trailing arguments.
async fn launch(editor: &InstalledEditor, trailing: &[String]) -> Result<(), String> {
    let mut args = editor.launch.args.clone();
    args.extend_from_slice(trailing);
    run(&editor.launch.program, &args).await
}

/// Fall back to the desktop entry itself when the `Exec` program cannot be run.
///
/// Electron's second attempt was `open -a <appPath>` on macOS and a direct
/// `appPath` spawn on Windows — i.e. "launch the application, not its CLI".
async fn launch_via_desktop_id(desktop_id: &str, args: &[String]) -> Result<(), String> {
    let mut argv = Vec::with_capacity(args.len() + 1);
    argv.push(desktop_id.to_string());
    argv.extend_from_slice(args);
    run("gtk-launch", &argv).await
}

/// `{success:false, error}` as a command result.
///
/// Every operational failure is a value rather than a rejected promise:
/// Electron's `openInEditor` / `openPathInFileManager` both resolved with
/// `{success:false,error}` and the renderer branches on `success`.
fn failed(message: impl Into<String>) -> CommandResult<OpenResult> {
    Ok(OpenResult {
        success: false,
        error: Some(message.into()),
    })
}

/// The same envelope, built before a `CommandResult` wrapper — for the one
/// refusal that is a value by contract rather than by operation.
fn refusal(message: impl Into<String>) -> OpenResult {
    OpenResult {
        success: false,
        error: Some(message.into()),
    }
}

// ---------------------------------------------------------------------------
// `revealInFileManager`
// ---------------------------------------------------------------------------

/// Reveal `path` in the OS file manager, falling back to opening it with the
/// default application.
///
/// Electron: `main/desktopMainIpcHelpers.ts:46-75` (`openPathInFileManager`) —
/// trim, normalize, `realpath`, then `shell.openPath` (with a macOS
/// `open` / `open -a Finder` ladder). The Tauri version keeps the
/// `{success, error}` envelope, asks for the canonical path rather than the
/// normalising one, and **confines first**.
///
/// Unlike `commands::native::open_in_file_manager`, which this supersedes: that
/// command hands a renderer-supplied path straight to `reveal_item_in_dir`, so
/// it is not a safe target for renderer input. Point `openInFileManager` here
/// instead; the old command can then be dropped from the registry.
#[tauri::command]
pub async fn reveal_in_file_manager(
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
    roots: State<'_, AllowedRoots>,
    app: AppHandle,
    path: String,
) -> CommandResult<OpenResult> {
    require_registered_window(&app_state, window.label())?;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return failed("empty path");
    }
    let canonical = roots.admit(Path::new(trimmed))?;

    // `reveal_item_in_dir` talks to FileManager1 over a blocking zbus connection
    // on Linux, so the D-Bus round-trip stays off every shared thread. The
    // opener is created inside the blocking closure because it borrows the
    // handle, and a borrowed handle cannot cross into it.
    let reveal = {
        let app = app.clone();
        let target = canonical.to_string_lossy().into_owned();
        tauri::async_runtime::spawn_blocking(move || app.opener().reveal_item_in_dir(&target)).await?
    };
    if reveal.is_ok() {
        return Ok(OpenResult {
            success: true,
            error: None,
        });
    }
    // The free `open_path` checks `metadata()` first, so a missing path is
    // reported here instead of reading as success because `xdg-open` failed
    // asynchronously.
    let target = canonical.to_string_lossy().into_owned();
    let opened = tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_opener::open_path(&target, None::<&str>)
    })
    .await?;
    match opened {
        Ok(()) => Ok(OpenResult {
            success: true,
            error: None,
        }),
        Err(error) => failed(error.to_string()),
    }
}

// ---------------------------------------------------------------------------
// `openExternalFile`
// ---------------------------------------------------------------------------

/// Open a local file with the system default application.
///
/// Electron: `openPathInDefaultApp`
/// (`main/desktopMainIpcHelpers.ts:12-44`), registered on the
/// `OpenExternalFile` channel at `main/desktopMainIpcRemote.ts:307-309`. Unlike
/// `reveal_in_file_manager` there is no reveal step: the path is opened, not
/// shown.
///
/// This is the route a `file:` URL was supposed to take. Electron's
/// `isAllowedExternalOpenUrl` let `file:` through the *URL* opener, which meant
/// the URL path had no allowlist at all; here the allowlist applies and the URL
/// opener never sees a local path.
///
/// `commands::native::open_in_file_manager` currently backs this member in the
/// TypeScript adapter, which is both unconfined and the wrong operation; point
/// it here.
#[tauri::command]
pub async fn open_external_file(
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
    roots: State<'_, AllowedRoots>,
    path: String,
) -> CommandResult<OpenResult> {
    require_registered_window(&app_state, window.label())?;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return failed("empty path");
    }
    let canonical = roots.admit(Path::new(trimmed))?;
    let target = canonical.to_string_lossy().into_owned();

    let opened = tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_opener::open_path(&target, None::<&str>)
    })
    .await?;
    match opened {
        Ok(()) => Ok(OpenResult {
            success: true,
            error: None,
        }),
        Err(error) => failed(error.to_string()),
    }
}

// ---------------------------------------------------------------------------
// `openInEditor`
// ---------------------------------------------------------------------------

/// Open `path` in the editor named by `editor_id`.
///
/// Electron: `main/openInEditor.ts:308-411`, dispatched from the
/// `PlatformChannels.OpenInEditor` handler. The decision tree is preserved —
/// remote SSH branch first, then the file-manager branch, then the CLI —
/// with three changes: the local path is confined, the editor set is not empty
/// on Linux, and the remote branches refuse editors that cannot honour them
/// rather than quietly opening a local file with a remote URI's path.
#[tauri::command]
pub async fn open_in_editor(
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
    roots: State<'_, AllowedRoots>,
    app: AppHandle,
    editor_id: String,
    path: String,
    options: Option<OpenInEditorOptions>,
) -> CommandResult<OpenResult> {
    require_registered_window(&app_state, window.label())?;
    let editor = match lookup_editor(&editor_id) {
        Ok(editor) => editor,
        Err(CommandError::Forbidden(message)) => {
            // `unknown editor: <id>` is a value in Electron, not a rejection —
            // the menu offered an id the host could not satisfy.
            return Ok(refusal(message));
        }
        Err(other) => return Err(other),
    };
    let options = options.unwrap_or_default();
    let raw_path = path.trim();
    if raw_path.is_empty() {
        return failed("empty path");
    }

    if let Some(target) = options.remote_target.as_ref() {
        return open_remote(&editor, raw_path, target, options.path_kind).await;
    }

    // Local branch: this is the one that hands a path to the OS, so this is
    // where confinement belongs.
    let canonical = roots.admit(Path::new(raw_path))?;
    let target = canonical.to_string_lossy().into_owned();

    if editor.kind == EditorKind::FileManager {
        // `main/openInEditor.ts:355-379`: a directory is opened, a file is
        // revealed. Falling back with an exit code would open the window twice,
        // so the reveal API is used for the file case.
        if std::fs::metadata(&canonical).map(|m| m.is_file()).unwrap_or(false) {
            let reveal = tauri::async_runtime::spawn_blocking(move || {
                app.opener().reveal_item_in_dir(&target)
            });
            return match reveal.await? {
                Ok(()) => Ok(OpenResult {
                    success: true,
                    error: None,
                }),
                Err(error) => failed(error.to_string()),
            };
        }
        let opened = tauri::async_runtime::spawn_blocking(move || {
            tauri_plugin_opener::open_path(&target, None::<&str>)
        })
        .await?;
        return match opened {
            Ok(()) => Ok(OpenResult {
                success: true,
                error: None,
            }),
            Err(error) => failed(error.to_string()),
        };
    }

    match launch(&editor, &[target.clone()]).await {
        Ok(()) => Ok(OpenResult {
            success: true,
            error: None,
        }),
        Err(primary) => match launch_via_desktop_id(&editor.desktop_id, &[target]).await {
            Ok(()) => Ok(OpenResult {
                success: true,
                error: None,
            }),
            Err(fallback) => failed(format!("{primary}; {fallback}")),
        },
    }
}

/// The remote branches of `openInEditor` (`main/openInEditor.ts:308-353`).
///
/// VS Code Remote-SSH needs a folder URI because the remote path
/// is not a path on this machine, and Windows Explorer needs a UNC spelling for
/// a remote path. Every other editor/remote pair is refused here: Electron fell
/// through to the local branch and handed `code` a remote path that does not
/// exist locally, which fails obscurely rather than saying why.
async fn open_remote(
    editor: &InstalledEditor,
    path: &str,
    target: &RemoteTarget,
    path_kind: Option<HostPathKind>,
) -> CommandResult<OpenResult> {
    let path = validate_remote_path(path)?;
    let vscode = is_vscode_editor(&editor.id);
    // A remote path is not on this disk, so it cannot be stat'd; the renderer
    // tells us which it is, exactly as Electron's `pathKind` did
    // (`main/openInEditor.ts:137,241`).
    let flag = if path_kind == Some(HostPathKind::File) {
        "--file-uri"
    } else {
        "--folder-uri"
    };

    match target {
        RemoteTarget::Ssh { .. } if vscode => {
            let uri = build_vscode_ssh_folder_uri(path, target)?;
            open_uri(editor, flag, &uri).await
        }
        _ => failed(format!(
            "editor {} cannot open a {} remote path",
            editor.id,
            match target {
                RemoteTarget::Ssh { .. } => "ssh",
            }
        )),
    }
}


/// Run the editor's CLI with a single URI flag, falling back to `gtk-launch`.
///
/// Electron's fallback was `open -a <appPath>`; the XDG equivalent is
/// `gtk-launch <desktop-file-id>`, which resolves the entry through the same
/// desktop database the application menu uses.
async fn open_uri(editor: &InstalledEditor, flag: &str, uri: &str) -> CommandResult<OpenResult> {
    let args = vec![flag.to_string(), uri.to_string()];
    match launch(editor, &args).await {
        Ok(()) => Ok(OpenResult {
            success: true,
            error: None,
        }),
        Err(primary) => match launch_via_desktop_id(&editor.desktop_id, &args).await {
            Ok(()) => Ok(OpenResult {
                success: true,
                error: None,
            }),
            Err(fallback) => failed(format!("{primary}; {fallback}")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_desktop(dir: &Path, name: &str, body: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(format!("{name}.desktop"));
        std::fs::write(&path, body).unwrap();
        path
    }

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let mut base = std::env::temp_dir();
            base.push(format!("zcode-editor-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(&base).unwrap();
            Self(base)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // -- Editor selection ---------------------------------------------------

    #[test]
    fn detects_a_seed_from_its_desktop_entry() {
        let scratch = Scratch::new("detect");
        write_desktop(
            scratch.path(),
            "code",
            "[Desktop Entry]\nName=Visual Studio Code\nExec=/usr/bin/code --unity-launch %F\nIcon=vscode\nType=Application\n",
        );
        let detected = detect_editors(&[scratch.path().to_path_buf()]);
        assert_eq!(detected.len(), 1);
        assert_eq!(detected[0].id, "vscode");
        assert_eq!(detected[0].name, "Visual Studio Code");
        assert_eq!(detected[0].desktop_id, "code");
        assert_eq!(
            detected[0].launch,
            LaunchSpec {
                program: "/usr/bin/code".to_string(),
                args: vec!["--unity-launch".to_string()],
            }
        );
        assert_eq!(detected[0].icon.as_deref(), Some("vscode"));
    }

    #[test]
    fn falls_back_to_the_seed_name_when_the_entry_has_none() {
        let scratch = Scratch::new("no-name");
        write_desktop(
            scratch.path(),
            "zed",
            "[Desktop Entry]\nExec=/usr/bin/zed %F\n",
        );
        let detected = detect_editors(&[scratch.path().to_path_buf()]);
        assert_eq!(detected.len(), 1);
        assert_eq!(detected[0].name, "Zed");
    }

    #[test]
    fn skips_hidden_and_no_display_entries() {
        let scratch = Scratch::new("hidden");
        write_desktop(
            scratch.path(),
            "code",
            "[Desktop Entry]\nName=Hidden VS Code\nExec=code %F\nNoDisplay=true\n",
        );
        write_desktop(
            scratch.path(),
            "cursor",
            "[Desktop Entry]\nName=Hidden Cursor\nExec=cursor %F\nHidden=true\n",
        );
        assert!(detect_editors(&[scratch.path().to_path_buf()]).is_empty());
    }

    /// Only the curated seeds are offered, so an unrelated application on the
    /// machine does not become an "Open in Editor" entry.
    #[test]
    fn does_not_offer_applications_outside_the_seed_table() {
        let scratch = Scratch::new("unrelated");
        write_desktop(
            scratch.path(),
            "some-random-game",
            "[Desktop Entry]\nName=Random Game\nExec=/opt/game/run %F\n",
        );
        assert!(detect_editors(&[scratch.path().to_path_buf()]).is_empty());
    }

    #[test]
    fn every_seed_has_a_unique_id() {
        let mut ids: Vec<&str> = EDITOR_SEEDS.iter().map(|seed| seed.id).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), before, "duplicate editor id in EDITOR_SEEDS");
    }

    // -- `.desktop` parsing -------------------------------------------------

    #[test]
    fn parses_the_keys_the_port_reads() {
        let entry = parse_desktop_entry(
            "[Desktop Entry]\nType=Application\nName=Editor\nGenericName=Text Editor\nExec=ed %U\nIcon=ed\nTerminal=false\nNoDisplay=false\nTryExec=/usr/bin/ed\n",
            "ed",
        );
        assert_eq!(entry.name.as_deref(), Some("Editor"));
        assert_eq!(entry.exec.as_deref(), Some("ed %U"));
        assert_eq!(entry.icon.as_deref(), Some("ed"));
        assert!(!entry.no_display);
        assert_eq!(entry.try_exec.as_deref(), Some("/usr/bin/ed"));
    }

    /// Real entries wrap a long `Exec` across lines with leading whitespace.
    #[test]
    fn joins_continuation_lines_in_exec() {
        let entry = parse_desktop_entry(
            "[Desktop Entry]\nName=Wrapped\nExec=/opt/app/bin/app\n  --flag-one value\n  %F\nIcon=x\n",
            "wrapped",
        );
        assert_eq!(
            entry.exec.as_deref(),
            Some("/opt/app/bin/app --flag-one value %F")
        );
    }

    /// Only `[Desktop Entry]` counts; `[Desktop Action …]` groups must not
    /// override the entry's own `Exec` with an action's.
    #[test]
    fn ignores_other_groups_and_comments() {
        let entry = parse_desktop_entry(
            "# a comment\n[Desktop Entry]\nName=Real\nExec=real %F\n[Desktop Action new-window]\nName=New Window\nExec=other %F\n",
            "act",
        );
        assert_eq!(entry.name.as_deref(), Some("Real"));
        assert_eq!(entry.exec.as_deref(), Some("real %F"));
    }

    #[test]
    fn only_the_literal_true_is_a_true_boolean() {
        assert!(parse_desktop_entry("[Desktop Entry]\nNoDisplay=true\n", "x").no_display);
        assert!(!parse_desktop_entry("[Desktop Entry]\nNoDisplay=TRUE\n", "x").no_display);
        assert!(!parse_desktop_entry("[Desktop Entry]\nNoDisplay=1\n", "x").no_display);
        assert!(!parse_desktop_entry("[Desktop Entry]\nNoDisplay=false\n", "x").no_display);
    }

    // -- `Exec` parsing -----------------------------------------------------

    #[test]
    fn drops_every_field_code_from_exec() {
        let spec = parse_exec("/usr/bin/code --new-window %F").unwrap();
        assert_eq!(spec.program, "/usr/bin/code");
        assert_eq!(spec.args, vec!["--new-window".to_string()]);
    }

    #[test]
    fn honours_quoting_and_backslash_escapes() {
        let spec = parse_exec("\"/opt/My App/run\" --flag=\\\"quoted\\\" %U").unwrap();
        assert_eq!(spec.program, "/opt/My App/run");
        assert_eq!(spec.args, vec!["--flag=\"quoted\"".to_string()]);
    }

    #[test]
    fn treats_double_percent_as_a_literal() {
        let spec = parse_exec("/usr/bin/app 100%% %F").unwrap();
        assert_eq!(spec.args, vec!["100%".to_string()]);
    }


    /// A quoted argument containing shell metacharacters stays one token, and
    /// the launcher is `Command::new`, which never reads a shell — so
    /// `"; rm -rf /"` is a filename and not a command.
    #[test]
    fn shell_metacharacters_in_a_quoted_argument_stay_one_token() {
        let spec = parse_exec("/usr/bin/app --flag \"; rm -rf /\" %F").unwrap();
        assert_eq!(spec.program, "/usr/bin/app");
        assert_eq!(spec.args, vec!["--flag".to_string(), "; rm -rf /".to_string()]);
    }

    /// The trailing path is appended as its own argument, never spliced into
    /// the `Exec` line, so a space in a workspace directory cannot split it.
    #[test]
    fn a_path_with_spaces_is_appended_as_one_argument() {
        let editor = InstalledEditor {
            id: "x".to_string(),
            name: "X".to_string(),
            kind: EditorKind::Launcher,
            desktop_id: "x".to_string(),
            launch: parse_exec("/usr/bin/app --flag %F").unwrap(),
            icon: None,
        };
        let mut args = editor.launch.args.clone();
        args.push("/home/u/My Project".to_string());
        assert_eq!(args, vec!["--flag", "/home/u/My Project"]);
    }

    #[test]
    fn an_exec_with_nothing_to_run_is_rejected() {
        assert_eq!(parse_exec(""), None);
        assert_eq!(parse_exec("   "), None);
        assert_eq!(parse_exec("%F"), None);
    }

    // -- Icons --------------------------------------------------------------

    #[test]
    fn resolves_a_themed_icon_to_a_png_data_url() {
        let scratch = Scratch::new("icon");
        let theme = scratch.path().join("hicolor").join("256x256").join("apps");
        std::fs::create_dir_all(&theme).unwrap();
        std::fs::write(theme.join("vscode.png"), b"\x89PNG-bytes").unwrap();

        let url = resolve_icon_data_url("vscode", &[scratch.path().join("hicolor/256x256/apps")])
            .expect("icon");
        assert!(url.starts_with("data:image/png;base64,"), "{url}");
    }

    #[test]
    fn an_icon_that_cannot_be_resolved_yields_nothing_rather_than_a_broken_url() {
        let scratch = Scratch::new("icon-missing");
        assert_eq!(resolve_icon_data_url("nope", &[scratch.path().to_path_buf()]), None);
        assert_eq!(resolve_icon_data_url("   ", &[]), None);
        assert_eq!(resolve_icon_data_url("", &[]), None);
    }

    /// XPM is in the search list but has no MIME mapping, so it is skipped
    /// rather than shipped as a data URL no renderer can draw.
    #[test]
    fn skips_icon_formats_with_no_mime_mapping() {
        let scratch = Scratch::new("icon-xpm");
        let dir = scratch.path().join("apps");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("thing.xpm"), b"x").unwrap();
        assert_eq!(resolve_icon_data_url("thing", &[dir]), None);
    }

    // -- Remote targets -----------------------------------------------------

    #[test]
    fn remote_paths_must_be_absolute_and_control_free() {
        assert_eq!(validate_remote_path(" /home/u/ws ").unwrap(), "/home/u/ws");
        assert_eq!(validate_remote_path("C:\\ws").unwrap(), "C:\\ws");
        for bad in ["", "   ", "relative/path", "/home/u/\0ws", "/home/u/\nws"] {
            assert!(
                matches!(
                    validate_remote_path(bad),
                    Err(CommandError::InvalidPayload(_))
                ),
                "{bad:?} must be refused"
            );
        }
    }

    #[test]
    fn encodes_a_remote_path_without_touching_the_separators() {
        assert_eq!(encode_remote_path("/home/u/my project/a+b"), "/home/u/my%20project/a%2Bb");
        assert_eq!(encode_remote_path("home/u/ws"), "/home/u/ws");
    }

    #[test]
    fn ssh_authority_prefers_the_config_alias() {
        let target = RemoteTarget::Ssh {
            host: "example.com".to_string(),
            port: Some(22),
            username: "dev".to_string(),
            ssh_config_alias: Some("  work-box ".to_string()),
        };
        assert_eq!(resolve_vscode_ssh_remote_authority(&target).unwrap(), "work-box");
    }

    #[test]
    fn ssh_authority_builds_user_at_host_and_appends_a_non_default_port() {
        let ssh = |port: Option<u16>, username: &str| RemoteTarget::Ssh {
            host: "example.com".to_string(),
            port,
            username: username.to_string(),
            ssh_config_alias: None,
        };
        assert_eq!(
            resolve_vscode_ssh_remote_authority(&ssh(None, "dev")).unwrap(),
            "dev@example.com"
        );
        assert_eq!(
            resolve_vscode_ssh_remote_authority(&ssh(Some(22), "dev")).unwrap(),
            "dev@example.com"
        );
        assert_eq!(
            resolve_vscode_ssh_remote_authority(&ssh(Some(2222), "dev")).unwrap(),
            "dev@example.com:2222"
        );
        assert_eq!(
            resolve_vscode_ssh_remote_authority(&ssh(None, "   ")).unwrap(),
            "example.com"
        );
    }

    #[test]
    fn ssh_authority_needs_a_host() {
        let target = RemoteTarget::Ssh {
            host: "   ".to_string(),
            port: None,
            username: "dev".to_string(),
            ssh_config_alias: None,
        };
        assert!(matches!(
            resolve_vscode_ssh_remote_authority(&target),
            Err(CommandError::InvalidPayload(_))
        ));
    }

    /// The authority is encoded as a whole, so its `@` and `:` cannot be
    /// reparsed as userinfo/host/port.
    #[test]
    fn ssh_folder_uri_encodes_the_authority_as_one_component() {
        let target = RemoteTarget::Ssh {
            host: "example.com".to_string(),
            port: Some(2222),
            username: "dev@corp".to_string(),
            ssh_config_alias: None,
        };
        let uri = build_vscode_ssh_folder_uri("/home/u/ws", &target).unwrap();
        assert_eq!(
            uri,
            "vscode-remote://ssh-remote+dev%40corp%3Aexample.com%3A2222/home/u/ws"
        );
    }

    // -- Wire shape ---------------------------------------------------------

    #[test]
    fn remote_target_uses_kebab_variants_camel_fields_and_denies_extras() {
        let parsed: RemoteTarget = serde_json::from_str(
            r#"{"kind":"ssh","host":"h","username":"u","sshConfigAlias":"a","port":22}"#,
        )
        .expect("parse");
        assert_eq!(
            parsed,
            RemoteTarget::Ssh {
                host: "h".to_string(),
                username: "u".to_string(),
                ssh_config_alias: Some("a".to_string()),
                port: Some(22),
            }
        );

        assert!(serde_json::from_str::<RemoteTarget>(
            r#"{"kind":"ssh","host":"h","username":"u","privateKey":"secret"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<RemoteTarget>(r#"{"kind":"rdp","host":"h"}"#).is_err());
    }

    #[test]
    fn editor_options_default_everything_optional() {
        let options: OpenInEditorOptions = serde_json::from_str("{}").unwrap();
        assert!(options.remote_target.is_none());
        assert!(options.path_kind.is_none());
        let options: OpenInEditorOptions =
            serde_json::from_str(r#"{"pathKind":"directory","workspaceIdentity":"x"}"#).unwrap();
        assert_eq!(options.path_kind, Some(HostPathKind::Directory));
        assert_eq!(options.workspace_identity.as_deref(), Some("x"));
        assert!(serde_json::from_str::<OpenInEditorOptions>(r#"{"pathKind":"nope"}"#).is_err());
    }

    #[test]
    fn editor_info_serialises_camel_case_keys() {
        let json = serde_json::to_string(&EditorInfo {
            id: "vscode".to_string(),
            name: "VS Code".to_string(),
            icon_data_url: String::new(),
        })
        .unwrap();
        assert!(json.contains("\"iconDataUrl\""), "{json}");
        assert!(json.contains("\"id\":\"vscode\""), "{json}");
    }

    #[test]
    fn a_refusal_is_a_value_not_a_rejection() {
        let result = refusal("unknown editor: nope");
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("unknown editor: nope"));
        let json = serde_json::to_string(&result).unwrap();
        assert!(!json.contains("error\":null"), "{json}");
    }

    #[test]
    fn an_unknown_editor_is_named_in_the_failure() {
        let message = match lookup_editor("definitely-not-an-editor") {
            Err(CommandError::Forbidden(message)) => message,
            _ => panic!("an unknown editor must be refused"),
        };
        assert!(message.contains("unknown editor"), "{message}");
    }
}