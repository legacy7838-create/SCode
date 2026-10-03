//! Bundled ZCode Built-in Provider Config materialisation.
//!
//! Rust port of `packages/provider-node/src/zcode-builtin-provider-config-materializer.ts`:
//! validate the embedded release by a full decode/encode round-trip, then place
//! it under `{environmentConfigRoot}/runtime/provider/bundled/zcode-builtin.json`
//! with the shared lock + atomic write, so concurrent startups never read a
//! half-written JSON.
//!
//! # Byte contract
//!
//! TS wrote `JSON.stringify(encode(decode(JSON.parse(content)))) + "\n"` — the
//! compact (not pretty) envelope plus one trailing newline. This port
//! reproduces exactly that.

use std::path::{Path, PathBuf};

use crate::schema::{decode_builtin_release, encode_builtin_release};

/// `{environmentConfigRoot}/runtime/provider/bundled/zcode-builtin.json`.
pub fn bundled_config_path(environment_config_root: &Path) -> PathBuf {
    environment_config_root
        .join("runtime")
        .join("provider")
        .join("bundled")
        .join("zcode-builtin.json")
}

/// Validate, then atomically place the release. Returns the file path, like
/// the TS materialiser. A rewrite only happens when the bytes differ.
pub fn materialize(environment_config_root: &Path, content: &str) -> Result<PathBuf, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(content).map_err(|error| format!("invalid JSON: {error}"))?;
    let release = decode_builtin_release(&parsed).map_err(|error| error.to_string())?;
    let encoded = encode_builtin_release(&release).map_err(|error| error.to_string())?;
    let mut normalized =
        String::from_utf8(encoded).map_err(|error| format!("release encode is not UTF-8: {error}"))?;
    normalized.push('\n');

    let file_path = bundled_config_path(environment_config_root);
    zcode_private_file::with_file_lock(&file_path, || {
        // Upgrading assumes the old process has exited, so no historical hash
        // copies are kept; matching bytes skip the write to keep mtime stable.
        match std::fs::read_to_string(&file_path) {
            Ok(existing) if existing == normalized => Ok(()),
            _ => zcode_private_file::atomic_write_private_text_file(&file_path, &normalized),
        }
    })?;
    Ok(file_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELEASE: &str = include_str!("../tests/_fixture_canonical_builtin.json");

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zcode-materialize-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn materialize_writes_the_compact_envelope_plus_one_newline() {
        let root = temp_root("bytes");
        let path = materialize(&root, RELEASE).expect("materialize");
        assert_eq!(path, bundled_config_path(&root));
        let written = std::fs::read_to_string(&path).expect("read back");
        assert!(written.ends_with("}\n"), "exactly one trailing newline");
        assert!(!written.ends_with("}\n\n"));
        // Compact, not pretty: no interior newlines.
        assert_eq!(written.matches('\n').count(), 1);
        let parsed: serde_json::Value = serde_json::from_str(&written).expect("parses");
        assert_eq!(parsed["schemaVersion"], serde_json::json!(1));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_second_materialize_with_the_same_content_skips_the_write() {
        let root = temp_root("stable");
        let path = materialize(&root, RELEASE).expect("first");
        let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        materialize(&root, RELEASE).expect("second");
        let mtime_after = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(mtime, mtime_after, "identical content must not rewrite");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_invalid_release_is_rejected_and_nothing_is_written() {
        let root = temp_root("invalid");
        assert!(materialize(&root, "not json").is_err());
        assert!(materialize(&root, r#"{"schemaVersion":2}"#).is_err());
        assert!(!bundled_config_path(&root).exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
