//! Filesystem and shell commands. Replaces `desktopSaveFile.ts`,
//! `desktopPrintToPdf.ts`, and the file/folder half of
//! `desktopMainIpcPlatform.ts`.
//!
//! Path handling note: Electron's `getPathForFile` handed the renderer an
//! absolute local path straight off a `File` object with no normalisation, and
//! the Electron side noted that safety depended entirely on main-side consumers
//! re-validating. The Tauri equivalent keeps the same data flow but routes every
//! filesystem read through an explicit allowlist root, so a dragged path outside
//! the permitted tree is rejected here rather than downstream.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{CommandError, CommandResult};
use crate::supervisor::Supervisor;

/// Roots the renderer may read from. Mirrors the Electron data base dir
/// (`getDataBaseDir()` in `main/desktopDataBaseDirBootstrap.ts`).
#[derive(Debug, Clone)]
pub struct AllowedRoots {
    roots: Vec<PathBuf>,
}

impl AllowedRoots {
    /// Build from the configured data base dir, falling back to `$HOME`.
    pub fn from_env() -> Self {
        let configured = std::env::var("ZCODE_DATA_BASE_DIR")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var("HOME").ok().map(PathBuf::from));
        let roots = configured.into_iter().collect();
        Self { roots }
    }

    /// True when `candidate` resolves inside an allowed root.
    pub fn contains(&self, candidate: &Path) -> bool {
        // Lexical normalisation first; `canonicalize` would resolve symlinks and
        // is deliberately avoided because the remote-workspace paths the renderer
        // legitimately sends are frequently not present on this machine.
        let normalised = normalise(candidate);
        self.roots
            .iter()
            .any(|root| normalised.starts_with(normalise(root)))
    }
}

/// Lexically resolve `.`/`..` without touching the filesystem.
fn normalise(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTextFileResult {
    pub contents: String,
}

/// Read a UTF-8 text file, rejecting anything outside the allowed roots.
#[tauri::command]
pub fn read_text_file(
    roots: State<'_, AllowedRoots>,
    path: String,
) -> CommandResult<ReadTextFileResult> {
    let candidate = PathBuf::from(path);
    if !roots.contains(&candidate) {
        return Err(CommandError::Forbidden(format!(
            "path outside allowed roots: {}",
            candidate.display()
        )));
    }
    let contents = std::fs::read_to_string(&candidate)
        .map_err(|e| CommandError::Platform(format!("{}: {e}", candidate.display())))?;
    Ok(ReadTextFileResult { contents })
}

/// Create a temporary text attachment, mirroring `createTempTextAttachment`
/// in `main/tempTextAttachment.ts`. Writes under the data base dir and returns
/// the path so the renderer can reference it in a prompt.
#[tauri::command]
pub fn create_temp_text_attachment(
    supervisor: State<'_, Supervisor>,
    contents: String,
    suggested_name: Option<String>,
) -> CommandResult<String> {
    let name = suggested_name.unwrap_or_else(|| "attachment.txt".to_string());
    // Reject traversal in the caller-supplied name; the temp dir is trusted but
    // the name is not.
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(CommandError::InvalidPayload(format!(
            "illegal attachment name: {name}"
        )));
    }
    let dir = supervisor
        .temp_attachment_dir()
        .map_err(|e| CommandError::Platform(e.to_string()))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| CommandError::Platform(e.to_string()))?;
    let target = dir.join(name);
    std::fs::write(&target, contents)
        .map_err(|e| CommandError::Platform(format!("{}: {e}", target.display())))?;
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_outside_root() {
        let roots = AllowedRoots { roots: vec![PathBuf::from("/home/u/.zcode")] };
        assert!(roots.contains(Path::new("/home/u/.zcode/a.txt")));
        assert!(!roots.contains(Path::new("/home/u/.zcode/../../etc/passwd")));
        assert!(!roots.contains(Path::new("/etc/passwd")));
    }

    #[test]
    fn normalises_lexically() {
        assert_eq!(
            normalise(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
    }
}
