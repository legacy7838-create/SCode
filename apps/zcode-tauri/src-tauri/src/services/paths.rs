//! Where ZCode keeps its data on disk.
//!
//! Transcribed from `packages/services/src/paths.ts`. The credential and
//! settings stores both live under here, so getting the precedence wrong does
//! not merely misplace a file — it points a reader at a store that does not
//! contain the logins the writer put somewhere else, and the user just appears
//! to be signed out.

use std::path::PathBuf;

/// `ZCODE_DATA_BASE_DIR`, checked by `paths.ts:11`.
const DATA_BASE_DIR_ENV_KEY: &str = "ZCODE_DATA_BASE_DIR";

/// The home directory, `$HOME` then `%USERPROFILE%`.
///
/// Empty and whitespace-only values are rejected, matching the `?.trim()` on the
/// TypeScript side. An empty `HOME` must not become a relative path: the result
/// would be a `.zcode` directory in whatever directory the process happened to
/// start in.
pub fn homedir() -> String {
    std::env::var("HOME")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var("USERPROFILE")
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_default()
}

/// `{dataBaseDir}`: `ZCODE_DATA_BASE_DIR`, else the home directory.
///
/// The TypeScript original also accepts a `setDataBaseDir()` override, which the
/// Electron main process calls at startup
/// (`packages/desktop/src/main/desktopDataBaseDirBootstrap.ts:44`) to relocate
/// the whole data root. There is no equivalent host-side setter in the Tauri
/// build yet, so only the environment leg is implemented here; the env var is
/// the one the CLI and desktop already export, so a relocated root is still
/// honoured for a process launched with it.
///
/// Unlike the original, which snapshots both values at module load, this reads
/// the environment per call. That is a deliberate difference: the original has
/// to, because a long-lived service instance would otherwise keep writing into a
/// directory the test harness has moved. Reading per call keeps the store and
/// the key derivation agreeing with whatever the process currently sees, which
/// is what correctness here actually depends on.
pub fn data_base_dir() -> PathBuf {
    std::env::var(DATA_BASE_DIR_ENV_KEY)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(homedir()))
}

/// `{dataBaseDir}/.zcode/v2`, the directory holding `credentials.json` and
/// `setting.json`.
pub fn app_config_dir() -> PathBuf {
    data_base_dir().join(".zcode").join("v2")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_data_base_dir_falls_back_to_home() {
        // A whitespace-only value is falsy after `trim()` on the TS side, so it
        // must not become a literal directory named " ".
        std::env::set_var(DATA_BASE_DIR_ENV_KEY, "   ");
        assert_eq!(data_base_dir(), PathBuf::from(homedir()));
        std::env::remove_var(DATA_BASE_DIR_ENV_KEY);
    }

    #[test]
    fn the_data_base_dir_is_honoured_and_joined_under_zcode_v2() {
        std::env::set_var(DATA_BASE_DIR_ENV_KEY, "/srv/zcode-data");
        assert_eq!(app_config_dir(), PathBuf::from("/srv/zcode-data/.zcode/v2"));
        std::env::remove_var(DATA_BASE_DIR_ENV_KEY);
    }
}
