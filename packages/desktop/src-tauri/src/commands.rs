// Real (non-stub) Tauri v2 commands for the Phase 2 vertical slice.
//
// Contract source of truth: `../tauri-port/BRIDGE.md`. Each command resolves a value from a
// genuine source (package metadata, OS locale, process environment, compile-time OS consts); the
// only hardcoded values are the documented fallbacks required by the contract.

use tauri::{AppHandle, Manager};

/// BCP-47 fallback locale used when the host OS locale cannot be resolved.
const FALLBACK_LOCALE: &str = "en-US";

/// Environment variable carrying a stable device identifier.
///
/// Reading a full, persisted machine-id (Electron parity) is deferred to a later phase; for this
/// slice the command reflects the real environment so the invoke() seam is exercised end to end.
const DEVICE_ID_ENV: &str = "ZCODE_DEVICE_ID";

/// Resolve a locale string from the host OS, falling back to a documented default.
///
/// # Arguments
///
/// * `raw` - The value returned by the OS locale probe (`None` when unavailable).
///
/// # Returns
///
/// The raw locale when present, otherwise [`FALLBACK_LOCALE`].
pub fn locale_or_default(raw: Option<String>) -> String {
    raw.unwrap_or_else(|| FALLBACK_LOCALE.to_string())
}

/// Resolve a device identifier from the environment, falling back to an empty string.
///
/// # Arguments
///
/// * `raw` - The value read from [`DEVICE_ID_ENV`] (`None` when unset).
///
/// # Returns
///
/// The raw id when present, otherwise an empty string.
pub fn device_id_from_env(raw: Option<String>) -> String {
    raw.unwrap_or_default()
}

/// Return the application package version, e.g. `"0.0.0"`.
///
/// Sourced directly from Tauri's embedded package metadata; requires a running app handle so it is
/// not covered by the pure unit tests.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing package info.
///
/// # Returns
///
/// The semantic version of the running package as a string.
#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Return the host system locale (BCP-47-ish), e.g. `"en-US"`.
///
/// Uses the `sys-locale` crate and falls back to [`FALLBACK_LOCALE`] when the OS locale is unknown.
#[tauri::command]
pub fn get_system_locale() -> String {
    locale_or_default(sys_locale::get_locale())
}

/// Return a stable device identifier, or `""` when unavailable.
///
/// Reads the `ZCODE_DEVICE_ID` environment variable. Full machine-id parity with Electron is a
/// later phase; this slice performs a real environment read rather than returning a constant.
#[tauri::command]
pub fn get_device_id() -> String {
    device_id_from_env(std::env::var(DEVICE_ID_ENV).ok())
}

/// Operating system and CPU architecture of the host running the Tauri shell.
///
/// Sourced at compile time from `std::env::consts` (`OS`/`ARCH`), so no extra crate is required.
/// Serialized to the renderer as `{ os, arch }` per the slice-2 bridge contract.
#[derive(serde::Serialize)]
pub struct PlatformInfo {
    /// Operating system identifier, e.g. `"linux"`, `"macos"`, `"windows"`.
    pub os: String,
    /// CPU architecture identifier, e.g. `"x86_64"`, `"aarch64"`.
    pub arch: String,
}

/// Build a [`PlatformInfo`] from raw OS and architecture strings.
///
/// Kept as a pure helper so the field wiring is unit-testable without a running app handle.
///
/// # Arguments
///
/// * `os` - Operating system identifier (typically `std::env::consts::OS`).
/// * `arch` - CPU architecture identifier (typically `std::env::consts::ARCH`).
///
/// # Returns
///
/// A [`PlatformInfo`] carrying the given `os` and `arch` values.
pub fn build_platform_info(os: &str, arch: &str) -> PlatformInfo {
    PlatformInfo {
        os: os.to_string(),
        arch: arch.to_string(),
    }
}

/// Return the host operating system and CPU architecture.
///
/// Values come from `std::env::consts::OS` and `std::env::consts::ARCH`, compiled into the binary.
#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    build_platform_info(std::env::consts::OS, std::env::consts::ARCH)
}

/// Return the application package name, e.g. `"ZCode"`.
///
/// Sourced from Tauri's embedded package metadata; requires a running app handle so it is not
/// covered by the pure unit tests.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing package info.
///
/// # Returns
///
/// The display name of the running package as a string.
#[tauri::command]
pub fn get_app_name(app: AppHandle) -> String {
    app.package_info().name.clone()
}

/// Convert a resolved directory path into an owned `String` for transport to the renderer.
///
/// Kept as a pure helper so the lossy UTF-8 coercion and trailing-separator normalization are
/// unit-testable without a running app handle. Tauri's `PathResolver::resolve` appends the
/// requested (here, empty) sub-path, so a base directory comes back with a trailing separator; we
/// strip it to yield a clean directory path. Non-UTF-8 sequences fall back to their lossy
/// representation rather than panicking, matching the "never `.unwrap()` in library paths" rule.
///
/// # Arguments
///
/// * `path` - The resolved filesystem directory path to stringify.
///
/// # Returns
///
/// The directory as an owned UTF-8 `String`, without a trailing path separator (the filesystem root
/// `"/"` is preserved).
pub fn directory_to_string(path: std::path::PathBuf) -> String {
    let raw = path.to_string_lossy();
    let trimmed = raw.trim_end_matches(std::path::is_separator).to_string();
    // Preserve the filesystem root, which would otherwise be trimmed to an empty string.
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed
    }
}

/// Return the host OS downloads directory, e.g. `"/home/user/Downloads"`.
///
/// Resolved through Tauri's built-in path API (`app.path().resolve("", BaseDirectory::Download)`),
/// so no extra crate is required. This is the first fallible command in the slice: the Rust `Err`
/// is converted to `Err(String)` via `.map_err(|e| e.to_string())` (never `.unwrap()`), which
/// surfaces on the TypeScript side as a rejected `Promise` — the error-propagation seam.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the path resolver.
///
/// # Returns
///
/// `Ok(String)` with the absolute downloads directory, or `Err(String)` describing why the OS
/// directory could not be resolved.
#[tauri::command]
pub fn get_download_directory(app: AppHandle) -> Result<String, String> {
    app.path()
        .resolve(
            std::ffi::OsStr::new(""),
            tauri::path::BaseDirectory::Download,
        )
        .map(directory_to_string)
        .map_err(|e| e.to_string())
}

/// Return the host OS documents directory, e.g. `"/home/user/Documents"`.
///
/// Resolved through Tauri's built-in path API (`app.path().resolve("", BaseDirectory::Document)`).
/// Shares the same fallible `Result<String, String>` contract as [`get_download_directory`]; the
/// Rust `Err` becomes a rejected `Promise` on the TypeScript side.
///
/// # Arguments
///
/// * `app` - The Tauri application handle providing the path resolver.
///
/// # Returns
///
/// `Ok(String)` with the absolute documents directory, or `Err(String)` describing why the OS
/// directory could not be resolved.
#[tauri::command]
pub fn get_documents_directory(app: AppHandle) -> Result<String, String> {
    app.path()
        .resolve(
            std::ffi::OsStr::new(""),
            tauri::path::BaseDirectory::Document,
        )
        .map(directory_to_string)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_falls_back_when_unavailable() {
        // Arrange
        let raw = None;

        // Act
        let result = locale_or_default(raw);

        // Assert
        assert_eq!(result, FALLBACK_LOCALE);
    }

    #[test]
    fn locale_passes_through_when_available() {
        // Arrange
        let raw = Some("de-DE".to_string());

        // Act
        let result = locale_or_default(raw);

        // Assert
        assert_eq!(result, "de-DE");
    }

    #[test]
    fn device_id_returns_env_value_when_present() {
        // Arrange
        let raw = Some("device-abc-123".to_string());

        // Act
        let result = device_id_from_env(raw);

        // Assert
        assert_eq!(result, "device-abc-123");
    }

    #[test]
    fn device_id_is_empty_when_env_absent() {
        // Arrange
        let raw = None;

        // Act
        let result = device_id_from_env(raw);

        // Assert
        assert_eq!(result, "");
    }

    #[test]
    fn platform_info_carries_os_and_arch() {
        // Arrange
        let os = "linux";
        let arch = "x86_64";

        // Act
        let info = build_platform_info(os, arch);

        // Assert
        assert_eq!(info.os, "linux");
        assert_eq!(info.arch, "x86_64");
    }

    #[test]
    fn platform_info_matches_compile_time_consts() {
        // Act: the command wires `std::env::consts` through the pure helper.
        let info = get_platform_info();

        // Assert
        assert_eq!(info.os, std::env::consts::OS);
        assert_eq!(info.arch, std::env::consts::ARCH);
    }

    #[test]
    fn directory_to_string_trims_trailing_separator() {
        // Arrange: Tauri's resolve appends an empty sub-path, yielding a trailing separator.
        let path = std::path::PathBuf::from("/home/user/Downloads/");

        // Act
        let result = directory_to_string(path);

        // Assert
        assert_eq!(result, "/home/user/Downloads");
    }

    #[test]
    fn directory_to_string_preserves_filesystem_root() {
        // Arrange
        let path = std::path::PathBuf::from("/");

        // Act
        let result = directory_to_string(path);

        // Assert
        assert_eq!(result, "/");
    }
}
