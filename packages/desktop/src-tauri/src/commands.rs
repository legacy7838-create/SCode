// Real (non-stub) Tauri v2 commands for the Phase 2 vertical slice.
//
// Contract source of truth: `../tauri-port/BRIDGE.md`. Each command resolves a value from a
// genuine source (package metadata, OS locale, process environment); the only hardcoded values
// are the documented fallbacks required by the contract.

use tauri::AppHandle;

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
}
