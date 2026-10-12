//! Error type for the AppImage strip tool.
//!
//! Message text mirrors `scripts/strip-appimage-system-libs.mjs` so operators see identical
//! `[appimage-strip] ...` diagnostics after the port. The `[appimage-strip]` prefix is added once
//! at the binary boundary (see `main.rs`), not per variant.

use std::path::PathBuf;

use thiserror::Error;

/// Any failure while finding, inspecting, stripping or repacking the AppImage.
#[derive(Debug, Error)]
pub enum StripError {
    /// The bundle directory that should contain the AppImage does not exist.
    #[error("bundle dir missing: {0}. Run `tauri build --bundles appimage` first.")]
    BundleDirMissing(PathBuf),

    /// The bundle directory exists but holds no `.AppImage`.
    #[error("no .AppImage found in {0}")]
    NoAppImage(PathBuf),

    /// The bundle directory holds more than one `.AppImage` (stale artifact).
    #[error("expected exactly one .AppImage, found {count}: {names}. Clean the bundle dir first.")]
    MultipleAppImages {
        /// How many `.AppImage` files were found.
        count: usize,
        /// Comma-joined basenames, for the operator to identify the stale file.
        names: String,
    },

    /// `readelf` could not be executed (binutils missing) — the safety gate would be blind.
    #[error("readelf failed on {path} (needed for the DT_NEEDED safety guard): {source}")]
    ReadelfNeededFailed {
        /// The ELF being inspected.
        path: PathBuf,
        /// Underlying spawn/IO error.
        source: std::io::Error,
    },

    /// `readelf -V` could not be executed (binutils missing) — the version gate would be blind.
    #[error("readelf -V failed on {path} (needed for the version safety guard): {source}")]
    ReadelfVersionFailed {
        /// The ELF being inspected.
        path: PathBuf,
        /// Underlying spawn/IO error.
        source: std::io::Error,
    },

    /// `ldconfig -p` could not be executed, so the host library cannot be located.
    #[error("ldconfig -p failed (needed to locate the host copy of {soname}): {source}")]
    LdconfigFailed {
        /// The library SONAME we were trying to locate.
        soname: String,
        /// Underlying spawn/IO error.
        source: std::io::Error,
    },

    /// The host has no library with this SONAME, so stripping would leave no fallback.
    #[error(
        "host has no {soname}; refusing to strip the bundled copy because no compatible fallback would remain."
    )]
    HostLibMissing {
        /// The missing library SONAME.
        soname: String,
    },

    /// The host copy is unversioned while an AppDir ELF needs versioned symbols from it.
    #[error(
        "host {soname} is unversioned but some AppDir ELFs require versioned symbols from it; refusing to strip."
    )]
    UnversionedHostRequiresVersions {
        /// The library SONAME.
        soname: String,
    },

    /// The host copy does not define every version an AppDir ELF requires (not a superset).
    #[error(
        "host {soname} does not define {missing} required by {dependent}; refusing to strip (would break the app)."
    )]
    HostMissingVersions {
        /// The library SONAME.
        soname: String,
        /// Comma-joined version names the host lacks.
        missing: String,
        /// Basename of the AppDir ELF that requires them.
        dependent: String,
    },

    /// Extracting the AppImage produced no `squashfs-root`.
    #[error("extraction produced no squashfs-root in {0}")]
    ExtractNoRoot(PathBuf),

    /// Running the AppImage with `--appimage-extract` failed.
    #[error("failed to extract {appimage}: {source}")]
    ExtractFailed {
        /// The AppImage being extracted.
        appimage: PathBuf,
        /// Underlying spawn/IO error.
        source: std::io::Error,
    },

    /// `$APPIMAGETOOL` points at a file that does not exist.
    #[error("APPIMAGETOOL points to a missing file: {0}")]
    AppimagetoolMissingFromEnv(PathBuf),

    /// `appimagetool` could not be found (neither `$APPIMAGETOOL` nor on `PATH`).
    #[error("appimagetool not found. Install it (CI does this) or set $APPIMAGETOOL.")]
    AppimagetoolNotFound,

    /// `appimagetool` ran but produced no output file.
    #[error("appimagetool produced no output at {0}")]
    RepackNoOutput(PathBuf),

    /// Running `appimagetool` failed.
    #[error("failed to repack {appdir} into {out}: {source}")]
    RepackFailed {
        /// The AppDir being repacked.
        appdir: PathBuf,
        /// The output AppImage path.
        out: PathBuf,
        /// Underlying spawn/IO error.
        source: std::io::Error,
    },

    /// A filesystem operation on the AppDir failed.
    #[error("{context} {path}: {source}")]
    Io {
        /// What we were doing when the IO failed.
        context: &'static str,
        /// The path involved.
        path: PathBuf,
        /// Underlying IO error.
        source: std::io::Error,
    },
}

/// Convenience for building [`StripError::Io`] with a path and context.
pub(crate) fn io_error(
    context: &'static str,
    path: &std::path::Path,
    source: std::io::Error,
) -> StripError {
    StripError::Io {
        context,
        path: path.to_path_buf(),
        source,
    }
}
