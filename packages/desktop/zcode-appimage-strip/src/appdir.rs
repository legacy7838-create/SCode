//! AppImage filesystem operations: locate the artifact, extract it, remove the safe-to-strip libs,
//! repack via `appimagetool`, and verify the result.
//!
//! Ported from `scripts/strip-appimage-system-libs.mjs`. Behavior kept identical: the same command
//! arguments, the same `APPIMAGE_EXTRACT_AND_RUN=1` / `ARCH` environment, the write-to-temp-then-
//! rename repack (so a failed run never clobbers a good AppImage), and the same verification.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

use crate::error::{io_error, StripError};

/// The Tauri `productName`-derived directory inside the AppImage where the host sidecar lives
/// (`usr/lib/<productName>/host`). `tauri.prod.json` sets `productName` to `ZCode`.
pub const HOST_RESOURCE_REL_DIR: &str = "usr/lib/ZCode/host";

/// Packaged host sidecar files; any missing one means the AppImage structure is broken.
pub const REQUIRED_HOST_FILES: &[&str] = &[
    "node",
    "standalone.js",
    "zcode_db.node",
    "agent/zcode.cjs",
    "provider/zcode-builtin.json",
];

/// Result of verifying a (possibly stripped) AppImage.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Inspection {
    /// Libraries that are still present but which the host could safely replace (i.e. strip failed).
    pub stripped_found: Vec<PathBuf>,
    /// Required host sidecar files that are missing.
    pub missing_host: Vec<String>,
}

/// Locate the single `.AppImage` in `appimage_dir`.
///
/// # Errors
/// - [`StripError::BundleDirMissing`] when the directory does not exist.
/// - [`StripError::NoAppImage`] when it holds none.
/// - [`StripError::MultipleAppImages`] when it holds more than one (stale artifact).
pub fn find_app_image(appimage_dir: &Path) -> Result<PathBuf, StripError> {
    if !appimage_dir.exists() {
        return Err(StripError::BundleDirMissing(appimage_dir.to_path_buf()));
    }
    let mut images: Vec<PathBuf> = Vec::new();
    let entries = fs::read_dir(appimage_dir)
        .map_err(|source| io_error("read bundle dir", appimage_dir, source))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e == "AppImage").unwrap_or(false) {
            images.push(path);
        }
    }
    match images.len() {
        // Absolutize before returning: the path is later used to spawn the AppImage from a temp-dir
        // cwd, and a relative path would resolve against the temp dir (ENOENT). Node's execFileSync
        // resolved relative to the parent's cwd instead, so this preserves that behavior.
        0 => Err(StripError::NoAppImage(appimage_dir.to_path_buf())),
        1 => absolutize(images.pop().expect("length checked to be 1")),
        count => {
            images.sort();
            let names = images
                .iter()
                .filter_map(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(", ");
            Err(StripError::MultipleAppImages { count, names })
        }
    }
}

/// Make `path` absolute against the current working directory (without requiring it to exist, so it
/// works for a symlinked or just-created file). Falls back to the input when the cwd is unavailable.
fn absolutize(path: PathBuf) -> Result<PathBuf, StripError> {
    if path.is_absolute() {
        return Ok(path);
    }
    let cwd = std::env::current_dir()
        .map_err(|source| io_error("resolve current dir", Path::new("."), source))?;
    Ok(cwd.join(path))
}

/// Extract `appimage` to a fresh temp dir via `--appimage-extract`, returning the `TempDir` (which
/// owns cleanup) and the `squashfs-root` path inside it.
///
/// `APPIMAGE_EXTRACT_AND_RUN=1` lets the runtime work without FUSE (CI's ubuntu-24.04 runner has no
/// `libfuse2`).
///
/// # Errors
/// [`StripError::ExtractFailed`] on spawn failure; [`StripError::ExtractNoRoot`] when extraction
/// leaves no `squashfs-root`.
pub fn extract_app_image(appimage: &Path) -> Result<(TempDir, PathBuf), StripError> {
    let work_dir = TempDir::new()
        .map_err(|source| io_error("create extract temp dir", Path::new(""), source))?;
    let status = Command::new(appimage)
        .arg("--appimage-extract")
        .current_dir(work_dir.path())
        .env("APPIMAGE_EXTRACT_AND_RUN", "1")
        .status();
    let status = match status {
        Ok(status) => status,
        Err(source) => {
            return Err(StripError::ExtractFailed {
                appimage: appimage.to_path_buf(),
                source,
            })
        }
    };
    if !status.success() {
        return Err(StripError::ExtractFailed {
            appimage: appimage.to_path_buf(),
            source: std::io::Error::other(format!("--appimage-extract exited with {status}")),
        });
    }
    let app_dir = work_dir.path().join("squashfs-root");
    if !app_dir.exists() {
        return Err(StripError::ExtractNoRoot(work_dir.path().to_path_buf()));
    }
    Ok((work_dir, app_dir))
}

/// Delete the named libraries from the extracted AppDir's `usr/lib` roots.
///
/// Returns the paths actually removed.
///
/// # Errors
/// [`StripError::Io`] when a removal fails.
pub fn strip_libs_from_app_dir(
    app_dir: &Path,
    libs: &[String],
) -> Result<Vec<PathBuf>, StripError> {
    let mut removed = Vec::new();
    for dir in [
        app_dir.join("usr/lib"),
        app_dir.join("usr/lib/x86_64-linux-gnu"),
    ] {
        if !dir.exists() {
            continue;
        }
        for lib in libs {
            let target = dir.join(lib);
            if target.exists() {
                fs::remove_file(&target)
                    .map_err(|source| io_error("remove shadowing lib", &target, source))?;
                removed.push(target);
            }
        }
    }
    Ok(removed)
}

/// Resolve the `appimagetool` executable: `$APPIMAGETOOL` if set (and existing), else a `PATH` scan.
///
/// # Errors
/// [`StripError::AppimagetoolMissingFromEnv`] when `$APPIMAGETOOL` points at a missing file;
/// [`StripError::AppimagetoolNotFound`] when it is neither set nor on `PATH`.
pub fn resolve_appimagetool() -> Result<PathBuf, StripError> {
    if let Ok(from_env) = std::env::var("APPIMAGETOOL") {
        let trimmed = from_env.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if !path.exists() {
                return Err(StripError::AppimagetoolMissingFromEnv(path));
            }
            return Ok(path);
        }
    }
    if let Some(found) = find_on_path("appimagetool") {
        return Ok(found);
    }
    Err(StripError::AppimagetoolNotFound)
}

/// Search `PATH` for an executable named `name` (mirrors the pty resolver's `is_executable`).
fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

/// True when `path` is a file with any execute bit set.
fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match fs::metadata(path) {
            Ok(meta) => meta.is_file() && meta.permissions().mode() & 0o111 != 0,
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Repack `app_dir` into `app_image_out` with `appimagetool`, replacing the file in place.
///
/// Writes to `<out>.stripped` first and renames over the target, so a failure never leaves a
/// half-written AppImage in place of a good one. Uses `appimagetool`'s own default runtime (do not
/// graft the original runtime bytes — that has been observed to core dump).
///
/// # Errors
/// [`StripError::RepackFailed`] on spawn failure; [`StripError::RepackNoOutput`] when no file was
/// produced; [`StripError::Io`] when the rename fails.
pub fn repack_app_image(app_dir: &Path, app_image_out: &Path) -> Result<(), StripError> {
    let appimagetool = resolve_appimagetool()?;
    let temp_out = PathBuf::from(format!("{}.stripped", app_image_out.display()));
    let _ = fs::remove_file(&temp_out);

    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    let status = Command::new(&appimagetool)
        .arg("--no-appstream")
        .arg(app_dir)
        .arg(&temp_out)
        .env("ARCH", arch)
        .env("APPIMAGE_EXTRACT_AND_RUN", "1")
        .status();
    let status = match status {
        Ok(status) => status,
        Err(source) => {
            return Err(StripError::RepackFailed {
                appdir: app_dir.to_path_buf(),
                out: temp_out,
                source,
            })
        }
    };
    if !status.success() {
        return Err(StripError::RepackFailed {
            appdir: app_dir.to_path_buf(),
            out: temp_out,
            source: std::io::Error::other(format!("appimagetool exited with {status}")),
        });
    }
    if !temp_out.exists() {
        return Err(StripError::RepackNoOutput(temp_out));
    }
    set_executable(&temp_out)?;
    fs::rename(&temp_out, app_image_out).map_err(|source| {
        io_error(
            "replace AppImage with repacked output",
            app_image_out,
            source,
        )
    })?;
    Ok(())
}

/// Set mode `0o755` on `path` (unix only; a no-op elsewhere).
fn set_executable(path: &Path) -> Result<(), StripError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))
            .map_err(|source| io_error("chmod repacked AppImage", path, source))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

/// Verify a (possibly stripped) AppImage: the strip targets are gone and the host sidecar is intact.
///
/// A [`SHADOWING_LIBS`](crate::gate::SHADOWING_LIBS) entry that is still present is only a failure
/// when the host could safely replace it — otherwise it is *correct* that it remains (it is a hard
/// dependency the gate refused to strip).
///
/// # Errors
/// [`StripError::ExtractFailed`]/[`StripError::ExtractNoRoot`] when re-extraction fails.
pub fn inspect_app_image(appimage: &Path) -> Result<Inspection, StripError> {
    let (_work_dir, app_dir) = extract_app_image(appimage)?;
    let mut stripped_found = Vec::new();
    for dir in [
        app_dir.join("usr/lib"),
        app_dir.join("usr/lib/x86_64-linux-gnu"),
    ] {
        if !dir.exists() {
            continue;
        }
        for lib in crate::gate::SHADOWING_LIBS {
            let candidate = dir.join(lib);
            if !candidate.exists() {
                continue;
            }
            // Still present: only a failure if the host could safely replace it (strip missed one).
            if crate::gate::verify_host_satisfies_dependents(&app_dir, lib).is_ok() {
                stripped_found.push(candidate);
            }
        }
    }
    let host_dir = app_dir.join(HOST_RESOURCE_REL_DIR);
    let missing_host = REQUIRED_HOST_FILES
        .iter()
        .filter(|rel| !host_dir.join(rel).exists())
        .map(|rel| (*rel).to_string())
        .collect();
    Ok(Inspection {
        stripped_found,
        missing_host,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_app_image_errors_when_dir_missing() {
        let err = find_app_image(Path::new("/no/such/bundle/dir/xyz")).unwrap_err();
        assert!(matches!(err, StripError::BundleDirMissing(_)));
    }

    #[test]
    fn find_app_image_none_single_and_multiple() {
        let dir = TempDir::new().unwrap();
        assert!(matches!(
            find_app_image(dir.path()),
            Err(StripError::NoAppImage(_))
        ));

        let one = dir.path().join("ZCode.AppImage");
        fs::write(&one, b"x").unwrap();
        assert_eq!(find_app_image(dir.path()).unwrap(), one);

        fs::write(dir.path().join("Stale.AppImage"), b"x").unwrap();
        assert!(matches!(
            find_app_image(dir.path()),
            Err(StripError::MultipleAppImages { count: 2, .. })
        ));
    }

    #[test]
    fn strip_removes_only_present_libs() {
        let dir = TempDir::new().unwrap();
        let lib_dir = dir.path().join("usr/lib");
        fs::create_dir_all(&lib_dir).unwrap();
        fs::write(lib_dir.join("libcrypto.so.3"), b"x").unwrap();

        let to_strip = vec!["libcrypto.so.3".to_string(), "libpcre2-8.so.0".to_string()];
        let removed = strip_libs_from_app_dir(dir.path(), &to_strip).unwrap();
        assert_eq!(removed, vec![lib_dir.join("libcrypto.so.3")]);
        assert!(!lib_dir.join("libcrypto.so.3").exists());
    }

    #[test]
    fn find_on_path_locates_an_executable_or_none() {
        // A name that cannot exist must not be found.
        assert_eq!(find_on_path("definitely-not-a-real-binary-xyz-123"), None);
    }
}
