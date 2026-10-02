//! Materialise the Built-in Provider Config embedded in the binary.
//!
//! Replaces `packages/server/src/bundledZCodeBuiltinProviderConfig.ts` +
//! `packages/provider-node/src/zcode-builtin-provider-config-materializer.ts`.
//!
//! # Why this runs in Rust before anything else
//!
//! `@zcode/server` did this in `entry-http.ts` before any RPC traffic: the
//! embedded release JSON is validated, re-serialised, and atomically written to
//! a fixed path, and the path is then injected into child processes through
//! `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`. With the Node server gone, every Rust
//! host that embeds the config must do the same or the agent spawned later
//! finds no release file and every built-in provider reports "not ready".
//!
//! # Output-byte contract
//!
//! The TS side wrote `serialize(decode(content)) + "\n"` — a round-trip that
//! only normalises key order. Downstream consumers `JSON.parse` the file, so
//! parsing equality is the contract, not byte equality. This port validates the
//! same top-level shape and writes the embedded bytes with a guaranteed single
//! trailing newline. The deep release validation (zod rules) lands with the
//! provider-runtime port; until then the structure check is the one that keeps
//! a corrupt embed from being written out at all.

use std::path::{Path, PathBuf};

use super::paths;
use super::private_file::{atomic_write_private_text_file, with_file_lock};

/// The embedded release, byte-identical to `config/provider/zcode-builtin.json`
/// at build time. `tsup` inlined this via `__ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__`;
/// `include_str!` is the same move for cargo.
const EMBEDDED_RELEASE_JSON: &str =
    include_str!("../../../../../config/provider/zcode-builtin.json");

/// `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` — exported so spawned children resolve the
/// same file (`packages/provider-node/src/runtime-paths.ts`).
const CONFIG_FILE_ENV: &str = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";

/// `{configRoot}/runtime/provider/bundled/zcode-builtin.json`.
pub fn bundled_config_path(environment_config_root: &Path) -> PathBuf {
    environment_config_root
        .join("runtime")
        .join("provider")
        .join("bundled")
        .join("zcode-builtin.json")
}

/// The materialised file's minimal shape: `schemaVersion === 1`, a non-negative
/// integer `revision`, and the two rule maps. Anything else is a packaging bug
/// and must fail the boot, never be written out for the agent to choke on.
fn validate_release(content: &str) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_str(content).map_err(|error| format!("bundled provider config is not JSON: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "bundled provider config must be a JSON object".to_string())?;
    if object.get("schemaVersion").and_then(|v| v.as_u64()) != Some(1) {
        return Err("bundled provider config must have schemaVersion 1".to_string());
    }
    let revision_ok = object
        .get("revision")
        .and_then(|v| v.as_u64())
        .is_some();
    if !revision_ok {
        return Err("bundled provider config must have a non-negative integer revision".to_string());
    }
    let config = object
        .get("config")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "bundled provider config must have a config object".to_string())?;
    for key in ["providerConfigRules", "modelConfigRules"] {
        if config.get(key).map(|v| v.is_object()) != Some(true) {
            return Err(format!("bundled provider config is missing config.{key}"));
        }
    }
    Ok(())
}

/// Validate, then atomically place the embedded release under
/// `{environmentConfigRoot}/runtime/provider/bundled/zcode-builtin.json`.
/// Returns the file path, like the TS materialiser.
pub fn materialize(environment_config_root: &Path) -> Result<PathBuf, String> {
    validate_release(EMBEDDED_RELEASE_JSON)?;
    let mut content = EMBEDDED_RELEASE_JSON.trim_end().to_owned();
    content.push('\n');

    let file_path = bundled_config_path(environment_config_root);
    with_file_lock(&file_path, || {
        // Rewrite only on content change: the lock + rename already make the
        // write atomic, and skipping the write on a match keeps the file's
        // mtime stable for caches keyed on it.
        match std::fs::read_to_string(&file_path) {
            Ok(existing) if existing == content => Ok(()),
            _ => atomic_write_private_text_file(&file_path, &content),
        }?;
        Ok(())
    })?;
    Ok(file_path)
}

/// Materialise under the app config dir and export the path for child processes.
/// Called once during host startup; the env var must be set before any agent
/// process is spawned, so failures here are fatal to startup, not deferred.
pub fn materialize_for_host() -> Result<PathBuf, String> {
    let file_path = materialize(&paths::app_config_dir())?;
    std::env::set_var(CONFIG_FILE_ENV, &file_path);
    Ok(file_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_release_passes_validation() {
        validate_release(EMBEDDED_RELEASE_JSON).expect("checked-in config must validate");
    }

    #[test]
    fn materialize_writes_the_bundled_file_with_a_trailing_newline() {
        let root = std::env::temp_dir().join(format!(
            "zcode-builtin-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let path = materialize(&root).expect("materialise");
        let written = std::fs::read_to_string(&path).expect("read back");
        assert!(written.ends_with("}\n"));
        let parsed: serde_json::Value = serde_json::from_str(&written).expect("parses");
        assert_eq!(parsed["schemaVersion"], serde_json::json!(1));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_release_missing_the_rule_maps_is_rejected() {
        assert!(validate_release(r#"{"schemaVersion":1,"revision":3,"config":{}}"#).is_err());
        assert!(validate_release("not json").is_err());
        assert!(validate_release(r#"{"schemaVersion":2,"revision":3}"#).is_err());
    }
}
