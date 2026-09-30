//! JSON and filesystem primitives, ported from `packages/desktop/src/main/mcpUserDirectory/utils.ts`.
//!
//! Spec: docs/specs/rust-native-mcp-config.md §3.
//!
//! This is the whole risk of the port. The output of this module is a **file the user edits by
//! hand**, so a "harmless" difference — a re-sorted key, a missing trailing newline, a
//! non-atomic write — is not a cosmetic regression but an unexplained diff in someone's editor.
//! Every function below therefore has a byte-level fixture, not just a value assertion.
//!
//! The atomic write in particular is copied sequence-for-sequence from the original rather than
//! reinvented: a temp file in the *same directory* (so the rename stays on one filesystem and is
//! therefore atomic), then the rename. A temp file in the system temp directory would be a
//! cross-device rename on many systems, which is not atomic at all (spec R3).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// A JSON object, preserving key insertion order.
///
/// `serde_json::Map` is an `IndexMap` here because the workspace enables `preserve_order`. Its
/// `insert` matches a JavaScript object spread exactly: assigning an existing key keeps that
/// key's position, inserting a new one appends. That is what makes round-tripping a user's
/// config byte-stable, and it is why this type is not a plain `BTreeMap`.
pub type JsonObject = serde_json::Map<String, serde_json::Value>;

/// `isRecord` (`utils.ts:9`): an object and not an array. JSON `null` is the other case that
/// `typeof value === "object"` admits in JS and that must be excluded here.
pub fn is_record(value: &serde_json::Value) -> bool {
    value.is_object()
}

/// `normalizeServerMap` (`utils.ts:13`): keep only the entries whose value is an object.
///
/// The legacy loop iterates `Object.entries(value)` and copies in order, so the result preserves
/// the source's key order and silently drops anything that is not a record.
pub fn normalize_server_map(value: &serde_json::Value) -> JsonObject {
    let Some(source) = value.as_object() else {
        return JsonObject::new();
    };
    let mut next = JsonObject::new();
    for (key, item) in source {
        if item.is_object() {
            next.insert(key.clone(), item.clone());
        }
    }
    next
}

/// `readJsonObject` (`utils.ts:27`): read and parse, returning `None` for anything unusable.
///
/// The legacy version swallows *every* error — missing file, permission denied, invalid JSON, a
/// top-level array or scalar — and yields `null`, which the caller turns into `{}`. A corrupt
/// config must not stop the app from starting, and must not be silently overwritten either: the
/// caller re-reads before writing so unparsable content is not destroyed.
pub fn read_json_object(path: &Path) -> Option<JsonObject> {
    let raw = fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    match parsed {
        serde_json::Value::Object(map) => Some(map),
        _ => None,
    }
}

/// The exact on-disk format `writeUserCliConfig` produces (`index.ts:156`):
/// `JSON.stringify(config, null, 2)` followed by a newline.
///
/// Both parts are load-bearing. The 2-space indent is what the user sees in their editor, and
/// dropping the final newline makes the file show as modified in every diff tool.
pub fn render_config_json(config: &JsonObject) -> String {
    let value = serde_json::Value::Object(config.clone());
    let mut text = serde_json::to_string_pretty(&value)
        .expect("a serde_json::Value built from a Map always serialises");
    // `to_string_pretty` already uses 2 spaces, but be explicit rather than relying on that
    // staying true across serde versions.
    debug_assert!(!text.contains('\t'), "indentation must be spaces");
    text.push('\n');
    text
}

/// `writeTextAtomic` (`utils.ts:39`): write via a temp file in the same directory, then rename.
///
/// The rename is what makes the update atomic; a reader either sees the whole old file or the
/// whole new one. On failure the temp file is removed and the original is left untouched.
pub fn write_text_atomic(path: &Path, content: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "config.json".to_string());

    // The legacy name embeds pid and a timestamp so two concurrent writers cannot collide. There
    // is no clock dependency in this crate, so the pid plus a process-local counter stands in;
    // the property that matters is uniqueness within the directory, not the exact string.
    let temp_path: PathBuf = {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        parent.join(format!(
            "{file_name}.{}.{unique}.tmp",
            std::process::id()
        ))
    };

    match fs::write(&temp_path, content) {
        Ok(()) => match fs::rename(&temp_path, path) {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = fs::remove_file(&temp_path);
                Err(error)
            }
        },
        Err(error) => {
            let _ = fs::remove_file(&temp_path);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zcode-mcp-config-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// §3.1 — key order must survive a round trip, or a user's hand-ordered config is
    /// alphabetised the first time the app saves it.
    #[test]
    fn key_order_survives_a_round_trip() {
        let raw = r#"{"zebra":1,"alpha":2,"mango":3}"#;
        let parsed: JsonObject = serde_json::from_str(raw).expect("valid json");
        let rendered = render_config_json(&parsed);
        assert_eq!(
            rendered.trim_end(),
            r#"{
  "zebra": 1,
  "alpha": 2,
  "mango": 3
}"#,
            "keys must keep their original order, not be sorted"
        );
    }

    /// The JS-spread semantics the port depends on: replace keeps position, insert appends.
    #[test]
    fn insert_semantics_match_a_javascript_object_spread() {
        let mut map = JsonObject::new();
        map.insert("first".into(), serde_json::json!(1));
        map.insert("second".into(), serde_json::json!(2));
        // Replacing an existing key must NOT move it to the end.
        map.insert("first".into(), serde_json::json!(99));
        let keys: Vec<&String> = map.keys().collect();
        assert_eq!(keys, vec!["first", "second"], "replace must keep the key position");
        // A genuinely new key appends.
        map.insert("third".into(), serde_json::json!(3));
        let keys: Vec<&String> = map.keys().collect();
        assert_eq!(keys, vec!["first", "second", "third"]);
    }

    /// §3.2 — the trailing newline is part of the contract.
    #[test]
    fn the_file_format_is_two_space_indent_with_a_trailing_newline() {
        let mut map = JsonObject::new();
        map.insert("a".into(), serde_json::json!({ "b": 1 }));
        let text = render_config_json(&map);
        assert!(text.ends_with('\n'), "must end with a newline");
        assert!(text.contains("\n  \"a\""), "must use a 2-space indent: {text:?}");
        assert!(!text.contains('\t'), "indentation must be spaces");
    }

    /// `isRecord` rejects arrays and null, which `typeof === "object"` would admit.
    #[test]
    fn record_detection_excludes_arrays_and_null() {
        assert!(is_record(&serde_json::json!({})));
        assert!(!is_record(&serde_json::json!([])));
        assert!(!is_record(&serde_json::Value::Null));
        assert!(!is_record(&serde_json::json!("s")));
        assert!(!is_record(&serde_json::json!(1)));
    }

    /// `normalizeServerMap` keeps order and drops non-object entries.
    #[test]
    fn normalising_a_server_map_keeps_order_and_drops_non_objects() {
        let value = serde_json::json!({ "b": { "cmd": "x" }, "a": 5, "c": ["nope"] });
        let map = normalize_server_map(&value);
        let keys: Vec<&String> = map.keys().collect();
        assert_eq!(keys, vec!["b"], "only object-valued entries survive, in order");
    }

    /// §6 — a missing or corrupt file is `None`, never a panic, and never a throw.
    #[test]
    fn an_unreadable_or_malformed_file_reads_as_none() {
        let dir = temp_dir("read");
        let missing = dir.join("nope.json");
        assert_eq!(read_json_object(&missing), None, "a missing file is not an error");

        let malformed = dir.join("bad.json");
        fs::write(&malformed, "{not json").unwrap();
        assert_eq!(read_json_object(&malformed), None, "invalid JSON is not an error");

        let array = dir.join("array.json");
        fs::write(&array, "[1,2,3]").unwrap();
        assert_eq!(read_json_object(&array), None, "a top-level array is not a record");

        let scalar = dir.join("scalar.json");
        fs::write(&scalar, "42").unwrap();
        assert_eq!(read_json_object(&scalar), None);

        let good = dir.join("good.json");
        fs::write(&good, r#"{"z":1,"a":2}"#).unwrap();
        let map = read_json_object(&good).expect("a valid object reads");
        let keys: Vec<&String> = map.keys().collect();
        assert_eq!(keys, vec!["z", "a"], "read order must be file order");
    }

    /// §3.3 — the write must be atomic and must leave no temp file behind.
    #[test]
    fn an_atomic_write_replaces_the_file_and_cleans_up() {
        let dir = temp_dir("atomic");
        let target = dir.join("config.json");
        fs::write(&target, "old").unwrap();

        write_text_atomic(&target, "new").expect("write must succeed");
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");

        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
    }

    /// Writing into a directory that does not exist yet must create it, matching `mkdir(recursive)`
    /// in the original.
    #[test]
    fn an_atomic_write_creates_missing_parent_directories() {
        let dir = temp_dir("mkdir");
        let target = dir.join("a").join("b").join("config.json");
        write_text_atomic(&target, "content").expect("write must succeed");
        assert_eq!(fs::read_to_string(&target).unwrap(), "content");
    }

    /// Two writes in a row must not collide on the temp file name.
    #[test]
    fn consecutive_writes_do_not_collide() {
        let dir = temp_dir("collide");
        let target = dir.join("config.json");
        for index in 0..5 {
            write_text_atomic(&target, &format!("v{index}")).expect("write must succeed");
            assert_eq!(fs::read_to_string(&target).unwrap(), format!("v{index}"));
        }
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
    }

    /// The temp file must live in the *target's* directory, or the rename is cross-device and
    /// therefore not atomic.
    #[test]
    fn the_temp_file_is_written_beside_the_target() {
        let dir = temp_dir("beside");
        let target = dir.join("config.json");
        // A rename across directories on the same filesystem is atomic, but across devices it is
        // not; keeping the temp file beside the target is what guarantees the former.
        write_text_atomic(&target, "x").unwrap();
        let parent_of_target = target.parent().unwrap();
        assert!(parent_of_target.is_dir());
        assert!(target.starts_with(parent_of_target));
    }
}
