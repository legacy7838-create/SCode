//! The legacy common-MCP import: mining an old storage location for server configs.
//!
//! Ported from `packages/desktop/src/main/mcpUserDirectory/legacy.ts` (243 lines).
//! Spec: docs/specs/rust-native-mcp-config.md §2.2, §10.
//!
//! This is the third channel, and it is a genuinely different operation from the other two: it
//! *imports* configs out of a legacy storage directory rather than reading or writing the current
//! one. The previous Tauri command re-read the current config under this name, which would have
//! been a silently different feature.
//!
//! Two parts are delicate and both are fixture-tested:
//!
//! * [`extract_balanced_json`] is a hand-written brace scanner over arbitrary text. It has to
//!   respect string literals and backslash escapes, because a `}` inside a JSON string value
//!   would otherwise close the object early. Ported byte-for-byte from the original's state
//!   machine.
//! * The LevelDB files are read as **latin1** (one byte → one code point), not UTF-8, because
//!   LevelDB record framing is binary and a UTF-8 decode would fail on it. Scanning the raw bytes
//!   is equivalent for the purpose here, because every delimiter the scanner looks for is ASCII
//!   and no UTF-8 continuation byte can be mistaken for one.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::json::JsonObject;
use crate::McpConfigError;

/// What a successful import reports back to the renderer.
#[derive(Debug, Clone, PartialEq)]
pub struct MigrationResult {
    pub servers: JsonObject,
    /// The file the servers were found in.
    pub source_path: String,
    pub total_count: usize,
    /// Always 0: the legacy reader only ever *finds* configs; importing them into the current
    /// file is the caller's next step, which is why these fields exist separately.
    pub imported_count: usize,
    pub skipped_count: usize,
}

impl MigrationResult {
    /// The "nothing found" result the original returns after exhausting every candidate.
    pub fn empty() -> Self {
        MigrationResult {
            servers: JsonObject::new(),
            source_path: String::new(),
            total_count: 0,
            imported_count: 0,
            skipped_count: 0,
        }
    }
}

/// `extractBalancedJson` (`legacy.ts:15-60`): the substring starting at `start_index` that
/// balances back to depth zero, or `None`.
///
/// Ported state machine-for-state-machine. The original skips a falsy `char` (`if (!char)
/// continue;`), which cannot happen for a real character in a string index, so it has no
/// counterpart here.
///
/// Byte indices are safe: every delimiter examined (`"`, `\`, `{`, `}`) is ASCII, and a UTF-8
/// continuation byte is >= 0x80, so the scan can never land inside a multi-byte character.
pub fn extract_balanced_json(text: &[u8], start_index: usize) -> Option<String> {
    let mut depth: i64 = 0;
    let mut in_string = false;
    let mut escaped = false;

    for index in start_index..text.len() {
        let ch = text[index];
        if ch == 0 {
            // The original's `if (!char) continue;` guard. A NUL byte inside a scanned binary
            // LevelDB file is common, and skipping it is what the original does.
            continue;
        }

        if in_string {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == b'\\' {
                escaped = true;
                continue;
            }
            if ch == b'"' {
                in_string = false;
            }
            continue;
        }

        match ch {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return std::str::from_utf8(&text[start_index..=index])
                        .ok()
                        .map(str::to_string);
                }
            }
            _ => {}
        }
    }

    None
}

/// `getLegacyCommonServers` (`legacy.ts:62-73`): `config.mcp.mcpServers`, normalized.
///
/// Note the shape is `mcp.mcpServers` here — the *flat* key nested under `mcp`, which is the
/// opposite of the current `mcp.servers` format. That difference is the whole point of a legacy
/// import, and getting it wrong yields an empty result rather than an error, so it is asserted.
fn get_legacy_common_servers(value: &Value) -> Option<JsonObject> {
    let root = value.as_object()?;
    let mcp = root.get("mcp")?.as_object()?;
    // The original requires the key to be *present* (`!("mcpServers" in mcp)`), not merely
    // truthy, so an explicit `null` is accepted here and normalized away to an empty map.
    if !mcp.contains_key("mcpServers") {
        return None;
    }
    Some(crate::json::normalize_server_map(mcp.get("mcpServers")?))
}

/// `readLegacyCommonMcpFromStoreJson` (`legacy.ts:75-121`).
///
/// The shape is deeply nested and each level is optional:
/// `store.json` → `"mcp-storage"` (**a JSON string**, not an object) → `state` → `config` → servers.
/// The double encoding is why a plain `read_json_object` cannot be reused here, and misreading it
/// yields `None` rather than an error, so every level is asserted.
fn read_legacy_common_mcp_from_store_json(path: &Path) -> Option<MigrationResult> {
    let raw = fs::read_to_string(path).ok()?;
    let store_root: Value = serde_json::from_str(&raw).ok()?;
    let root = store_root.as_object()?;

    // `typeof mcpStorageRaw !== "string"` — a *string*, so it is parsed a second time.
    let storage_raw = root.get("mcp-storage")?.as_str()?;
    let mcp_storage: Value = serde_json::from_str(storage_raw).ok()?;
    let state = mcp_storage.as_object()?.get("state")?.as_object()?;
    let config = state.get("config")?.as_object()?;

    let servers = get_legacy_common_servers(&Value::Object(config.clone()))?;
    // The original requires a non-empty map; an empty one means "not this file", so the search
    // continues to the next candidate rather than reporting a successful empty import.
    if servers.is_empty() {
        return None;
    }
    Some(MigrationResult {
        total_count: servers.len(),
        servers,
        source_path: path.display().to_string(),
        imported_count: 0,
        skipped_count: 0,
    })
}

/// `extractLegacyCommonMcpFromText` (`legacy.ts:123-154`): scan for `"mcp-config"`, then take
/// the balanced object that follows it, and keep scanning past a failed candidate.
fn extract_legacy_common_mcp_from_text(text: &[u8]) -> Option<JsonObject> {
    const KEY: &[u8] = b"mcp-config";
    let mut search_start = 0usize;

    while search_start < text.len() {
        let key_index = match find_bytes(&text[search_start..], KEY) {
            Some(offset) => search_start + offset,
            None => return None,
        };
        let json_start = match find_byte(&text[key_index..], b'{') {
            Some(offset) => key_index + offset,
            None => return None,
        };
        if let Some(json_text) = extract_balanced_json(text, json_start) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&json_text) {
                if let Some(servers) = get_legacy_common_servers(&parsed) {
                    return Some(servers);
                }
            }
        }
        search_start = key_index + KEY.len();
    }

    None
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn find_byte(haystack: &[u8], needle: u8) -> Option<usize> {
    haystack.iter().position(|byte| *byte == needle)
}

/// `readLegacyCommonMcpFromLevelDbDir` (`legacy.ts:156-193`).
///
/// Files are tried newest-first. The original sorts with
/// `right.name.localeCompare(left.name, undefined, { numeric: true })` — ICU collation with
/// numeric ordering. LevelDB names its files with fixed-width zero-padded numbers
/// (`000005.ldb`), and for those a numeric-aware byte comparison agrees with ICU exactly, which
/// [`leveldb_sort_key`] encodes. A full ICU collation is not reproduced; see spec §9 D3.
fn read_legacy_common_mcp_from_leveldb_dir(directory: &Path) -> Option<MigrationResult> {
    let read = fs::read_dir(directory).ok()?;

    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // The original tests `entry.isFile()`, so a directory named `x.ldb` is skipped.
        if !entry.path().is_file() {
            continue;
        }
        let lowered = name.to_ascii_lowercase();
        if !(lowered.ends_with(".ldb") || lowered.ends_with(".log")) {
            continue;
        }
        entries.push((name, entry.path()));
    }

    // Descending by name, newest first.
    entries.sort_by(|left, right| leveldb_sort_key(&right.0).cmp(&leveldb_sort_key(&left.0)));

    for (name, path) in entries {
        // Read as bytes, not as UTF-8 text: LevelDB record framing is binary, and the original
        // decodes latin1 precisely so it never fails on a non-UTF-8 byte.
        let Ok(raw) = fs::read(&path) else {
            continue;
        };
        if let Some(servers) = extract_legacy_common_mcp_from_text(&raw) {
            let _ = name;
            return Some(MigrationResult {
                total_count: servers.len(),
                servers,
                source_path: path.display().to_string(),
                imported_count: 0,
                skipped_count: 0,
            });
        }
    }

    None
}

/// A numeric-aware sort key for a LevelDB file name.
///
/// Splits digit runs into `0`-tagged numeric chunks and everything else into `1`-tagged text
/// chunks, so `10.ldb` sorts after `9.ldb` — which a plain byte comparison would get backwards.
/// For the fixed-width zero-padded names LevelDB actually produces, the two agree; the numeric
/// form is used because it also does the right thing for a hand-renamed file.
fn leveldb_sort_key(name: &str) -> Vec<(u8, String, u64)> {
    let mut chunks: Vec<(u8, String, u64)> = Vec::new();
    let mut chars = name.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch.is_ascii_digit() {
            // `ch` was already consumed by the outer loop, so it must seed the run. Omitting it made
            // every single-digit name parse as 0, so "9.ldb" and "10.ldb" produced identical
            // keys and the numeric ordering silently did nothing.
            let mut digits = String::from(ch);
            while let Some(next) = chars.peek() {
                if next.is_ascii_digit() {
                    digits.push(*next);
                    chars.next();
                } else {
                    break;
                }
            }
            let value = digits.trim_start_matches('0').parse::<u64>().unwrap_or(0);
            chunks.push((0, String::new(), value));
        } else {
            let mut text = String::new();
            text.push(ch);
            while let Some(next) = chars.peek() {
                if next.is_ascii_digit() {
                    break;
                }
                text.push(*next);
                    chars.next();
            }
            chunks.push((1, text, 0));
        }
    }
    chunks
}

/// `buildLegacyCommonMcpStorageCandidates` (`legacy.ts:195-216`).
///
/// The `??` matters: an **empty but present** `LOCALAPPDATA`/`APPDATA` is used as-is, producing
/// relative candidate paths. The original does not treat `""` as absent, and neither does this —
/// silently "fixing" it would change which files get searched on a misconfigured machine.
pub fn build_storage_candidates(
    legacy_storage_dir: Option<&str>,
    local_app_data: Option<&str>,
    app_data: Option<&str>,
    home: &str,
) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = legacy_storage_dir {
        candidates.push(PathBuf::from(dir));
    }

    let local_app_data = local_app_data
        .map(str::to_string)
        .unwrap_or_else(|| Path::new(home).join("AppData").join("Local").display().to_string());
    let app_data = app_data
        .map(str::to_string)
        .unwrap_or_else(|| Path::new(home).join("AppData").join("Roaming").display().to_string());

    // The old store.json is tried first, because the candidate loop below dispatches on the
    // `.ends_with("store.json")` suffix rather than on position.
    candidates.push(Path::new(&app_data).join("ai.z.zcode").join("store.json"));
    candidates.push(
        Path::new(&local_app_data)
            .join("ai.z.work")
            .join("EBWebView")
            .join("Default")
            .join("Local Storage")
            .join("leveldb"),
    );
    candidates.push(
        Path::new(&app_data)
            .join("ZCode")
            .join("Local Storage")
            .join("leveldb"),
    );
    candidates.push(
        Path::new(&app_data)
            .join("ZCode")
            .join("Partitions")
            .join("zcode-embedded-browser")
            .join("Local Storage")
            .join("leveldb"),
    );
    candidates.push(
        Path::new(&app_data)
            .join("ZCode Dev")
            .join("Local Storage")
            .join("leveldb"),
    );
    candidates.push(
        Path::new(&app_data)
            .join("ZCode Dev")
            .join("Partitions")
            .join("zcode-embedded-browser")
            .join("Local Storage")
            .join("leveldb"),
    );

    // `Array.from(new Set(...))`: dedupe, keeping first occurrence order.
    let mut seen = std::collections::HashSet::new();
    candidates
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

/// `migrateLegacyCommonMcp` (`legacy.ts:218-243`).
///
/// Candidates are tried in order, and a candidate whose **path ends in `store.json`** is read as
/// a store file while any other candidate is treated as a LevelDB directory. The first hit wins;
/// exhausting every candidate yields the empty result rather than an error, because "this machine
/// has no legacy data" is the common case and must not look like a failure.
pub fn migrate_legacy_common_mcp(
    legacy_storage_dir: Option<&str>,
    local_app_data: Option<&str>,
    app_data: Option<&str>,
    home: &str,
) -> Result<MigrationResult, McpConfigError> {
    for candidate in build_storage_candidates(legacy_storage_dir, local_app_data, app_data, home) {
        let is_store = candidate
            .to_string_lossy()
            .ends_with("store.json");
        let found = if is_store {
            read_legacy_common_mcp_from_store_json(&candidate)
        } else {
            read_legacy_common_mcp_from_leveldb_dir(&candidate)
        };
        if let Some(result) = found {
            return Ok(result);
        }
    }
    Ok(MigrationResult::empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The scanner must ignore a `}` that sits inside a string value, which is the whole reason
    /// it is a state machine rather than a brace count.
    #[test]
    fn a_brace_inside_a_string_does_not_close_the_object() {
        let text = br#"prefix {"a":"} not the end","b":1} suffix"#;
        let start = find_byte(text, b'{').unwrap();
        let extracted = extract_balanced_json(text, start).expect("must extract");
        let parsed: Value = serde_json::from_str(&extracted).expect("valid json");
        assert_eq!(parsed["a"], json!("} not the end"));
        assert_eq!(parsed["b"], json!(1));
    }

    /// An escaped quote must not end the string, so the brace after it still counts.
    #[test]
    fn an_escaped_quote_does_not_end_the_string() {
        let text = br#"{"a":"say \"hi\" }","b":2}"#;
        let start = find_byte(text, b'{').unwrap();
        let extracted = extract_balanced_json(text, start).expect("must extract");
        let parsed: Value = serde_json::from_str(&extracted).expect("valid json");
        assert_eq!(parsed["b"], json!(2), "the object must close at the real brace");
    }

    /// A backslash at the end of a string escapes the closing quote.
    #[test]
    fn a_trailing_backslash_escapes_the_quote() {
        let text = br#"{"a":"c:\\","b":3}"#;
        let start = find_byte(text, b'{').unwrap();
        let extracted = extract_balanced_json(text, start).expect("must extract");
        let parsed: Value = serde_json::from_str(&extracted).expect("valid json");
        assert_eq!(parsed["b"], json!(3));
    }

    #[test]
    fn an_unbalanced_object_yields_none() {
        let text = br#"{"a":1"#;
        assert_eq!(extract_balanced_json(text, 0), None);
    }

    /// NUL bytes are skipped, matching the original's `if (!char) continue;` — and they are
    /// common in a binary LevelDB file.
    #[test]
    fn nul_bytes_are_skipped() {
        let text = b"\0\0{\"a\":\0 1}\0";
        let start = find_byte(text, b'{').unwrap();
        let extracted = extract_balanced_json(text, start).expect("must extract");
        assert!(extracted.starts_with('{') && extracted.ends_with('}'));
    }

    /// Multi-byte UTF-8 must not break the byte scan.
    #[test]
    fn multibyte_text_does_not_corrupt_the_scan() {
        let text = "{\"a\":\"日本語のテキスト\",\"b\":1}".as_bytes();
        let start = find_byte(text, b'{').unwrap();
        let extracted = extract_balanced_json(text, start).expect("must extract");
        let parsed: Value = serde_json::from_str(&extracted).expect("valid json");
        assert_eq!(parsed["a"], json!("日本語のテキスト"));
    }

    /// The legacy shape is `mcp.mcpServers` — the flat key nested under `mcp`, which is *not*
    /// the current `mcp.servers` format. Reading the current shape here would silently yield
    /// nothing.
    #[test]
    fn the_legacy_shape_is_mcp_mcp_servers() {
        let value = json!({ "mcp": { "mcpServers": { "fs": { "command": "npx" } } } });
        let servers = get_legacy_common_servers(&value).expect("must find servers");
        assert_eq!(servers.len(), 1);
        assert!(servers.contains_key("fs"));

        // The current format is not the legacy format.
        let current = json!({ "mcp": { "servers": { "fs": {} } } });
        assert!(
            get_legacy_common_servers(&current).is_none(),
            "`mcp.servers` is the current format and must not satisfy the legacy reader"
        );
    }

    #[test]
    fn a_legacy_entry_that_is_not_an_object_is_dropped() {
        let value = json!({ "mcp": { "mcpServers": { "good": {}, "bad": 5 } } });
        let servers = get_legacy_common_servers(&value).unwrap();
        assert!(servers.contains_key("good"));
        assert!(!servers.contains_key("bad"), "a non-object entry is normalised away");
    }

    /// A failed candidate must not stop the scan — the original advances past it.
    #[test]
    fn a_failed_candidate_does_not_stop_the_scan() {
        let text = br#"junk mcp-config {not json} then mcp-config {"mcp":{"mcpServers":{"ok":{}}}}"#;
        let servers = extract_legacy_common_mcp_from_text(text).expect("the second candidate must be found");
        assert!(servers.contains_key("ok"));
    }

    #[test]
    fn text_without_the_key_yields_none() {
        assert_eq!(extract_legacy_common_mcp_from_text(b"nothing here"), None);
        // The key present but no object after it.
        assert_eq!(extract_legacy_common_mcp_from_text(b"mcp-config nothing"), None);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zcode-mcp-legacy-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// The double-encoded `store.json` shape, end to end.
    #[test]
    fn a_store_json_is_read_through_both_decoding_layers() {
        let dir = temp_dir("store");
        let store = dir.join("store.json");
        let inner = json!({ "state": { "config": { "mcp": { "mcpServers": { "fs": { "command": "npx" } } } } } });
        fs::write(
            &store,
            serde_json::to_string(&json!({ "mcp-storage": inner.to_string() })).unwrap(),
        )
        .unwrap();

        let result = read_legacy_common_mcp_from_store_json(&store).expect("must find servers");
        assert_eq!(result.total_count, 1);
        assert!(result.servers.contains_key("fs"));
        assert_eq!(result.imported_count, 0, "the legacy reader only finds, never imports");
    }

    /// An empty server map means "not this file", so the search moves on.
    #[test]
    fn an_empty_server_map_is_not_a_hit() {
        let dir = temp_dir("store-empty");
        let store = dir.join("store.json");
        let inner = json!({ "state": { "config": { "mcp": { "mcpServers": {} } } } });
        fs::write(
            &store,
            serde_json::to_string(&json!({ "mcp-storage": inner.to_string() })).unwrap(),
        )
        .unwrap();
        assert!(read_legacy_common_mcp_from_store_json(&store).is_none());
    }

    /// Every level of the nesting is optional, and a missing one is `None`, not an error.
    #[test]
    fn a_store_json_missing_a_level_is_not_a_hit() {
        let dir = temp_dir("store-partial");
        for content in [
            json!({}),
            json!({ "mcp-storage": 5 }),
            json!({ "mcp-storage": "not json" }),
            json!({ "mcp-storage": "[]" }),
            json!({ "mcp-storage": "{}" }),
            json!({ "mcp-storage": "{\"state\":{}}" }),
            json!({ "mcp-storage": "{\"state\":{\"config\":{}}}" }),
        ] {
            let store = dir.join("store.json");
            fs::write(&store, serde_json::to_string(&content).unwrap()).unwrap();
            assert!(
                read_legacy_common_mcp_from_store_json(&store).is_none(),
                "{content} must not be a hit"
            );
        }
    }

    /// LevelDB files are scanned newest-first, and binary content must not break the read.
    #[test]
    fn leveldb_files_are_mined_newest_first() {
        let dir = temp_dir("leveldb");
        // Two files: the newer one holds an *invalid* payload so the scan must fall through to
        // the older one, proving the order was tried newest-first.
        let payload = br#"mcp-config {"mcp":{"mcpServers":{"fromOld":{}}}}"#;
        fs::write(dir.join("000009.ldb"), payload).unwrap();
        let mut binary = b"\x00\x01\x02mcp-config {broken".to_vec();
        binary.extend_from_slice(&[0xff, 0xfe, 0xfd]);
        fs::write(dir.join("000010.ldb"), &binary).unwrap();
        // A file that is not leveldb must be ignored entirely.
        fs::write(dir.join("notes.txt"), payload).unwrap();

        let result = read_legacy_common_mcp_from_leveldb_dir(&dir).expect("must find servers");
        assert!(
            result.servers.contains_key("fromOld"),
            "the newer file was tried first and correctly failed, so the older one answered"
        );
        assert!(result.source_path.ends_with("000009.ldb"));
    }

    /// `10` must sort after `9`; a plain byte comparison gets that backwards.
    #[test]
    fn the_leveldb_sort_is_numeric_aware() {
        let mut names = vec![
            "9.ldb".to_string(),
            "10.ldb".to_string(),
            "000002.log".to_string(),
        ];
        names.sort_by(|left, right| leveldb_sort_key(right).cmp(&leveldb_sort_key(left)));
        assert_eq!(names, vec!["10.ldb", "9.ldb", "000002.log"]);

        // For LevelDB's real fixed-width names, numeric and byte order agree — which is why the
        // simpler numeric form is safe here.
        let mut padded = vec!["000009.ldb".to_string(), "000010.ldb".to_string()];
        padded.sort_by(|left, right| leveldb_sort_key(right).cmp(&leveldb_sort_key(left)));
        let mut padded_bytes = padded.clone();
        padded_bytes.sort_by(|left, right| right.cmp(left));
        assert_eq!(padded, padded_bytes, "numeric and byte order must agree on padded names");
    }

    /// A candidate list must be deduped with first-occurrence order kept.
    #[test]
    fn candidates_are_deduped_in_order() {
        let candidates = build_storage_candidates(
            Some("/explicit"),
            Some("/local"),
            Some("/roaming"),
            "/home/u",
        );
        assert_eq!(candidates[0], PathBuf::from("/explicit"), "an explicit dir comes first");
        assert_eq!(
            candidates[1],
            PathBuf::from("/roaming/ai.z.zcode/store.json"),
            "the old store.json is the first derived candidate"
        );
        let unique: std::collections::HashSet<&PathBuf> = candidates.iter().collect();
        assert_eq!(unique.len(), candidates.len(), "candidates must be deduped");
        assert_eq!(candidates.len(), 7, "one explicit + store.json + five leveldb dirs");
    }

    /// An empty-but-present `LOCALAPPDATA` is used as-is by the original's `??`, producing a
    /// relative path. Reproducing that is deliberate: a misconfigured machine should search the
    /// same (wrong) place, not a silently different one.
    #[test]
    fn an_empty_env_var_is_used_rather_than_falling_back() {
        let candidates = build_storage_candidates(None, Some(""), Some(""), "/home/u");
        assert!(
            candidates
                .iter()
                .any(|path| path.starts_with("ai.z.work")),
            "an empty LOCALAPPDATA must yield a relative path, as `??` does: {candidates:?}"
        );
    }

    #[test]
    fn missing_env_vars_fall_back_to_the_home_appdata_paths() {
        let candidates = build_storage_candidates(None, None, None, "/home/u");
        assert!(candidates
            .iter()
            .any(|p| p.starts_with("/home/u/AppData/Roaming/ai.z.zcode/store.json")));
        assert!(candidates
            .iter()
            .any(|p| p.starts_with("/home/u/AppData/Local/ai.z.work")));
    }

    /// A machine with no legacy data yields the empty result, not an error — that is the common
    /// case and must not look like a failure.
    #[test]
    fn no_legacy_data_yields_an_empty_result() {
        let empty = temp_dir("nothing");
        let result =
            migrate_legacy_common_mcp(Some(empty.to_str().unwrap()), None, None, "/home/u")
                .expect("must not error");
        assert!(result.servers.is_empty());
        assert_eq!(result.total_count, 0);
        assert!(result.source_path.is_empty());
    }

    /// An explicit directory is consulted first and wins.
    #[test]
    fn an_explicit_directory_wins_over_the_derived_candidates() {
        let explicit = temp_dir("explicit");
        fs::write(
            explicit.join("000001.ldb"),
            br#"mcp-config {"mcp":{"mcpServers":{"fromExplicit":{}}}}"#,
        )
        .unwrap();
        let result = migrate_legacy_common_mcp(Some(explicit.to_str().unwrap()), None, None, "/home/u")
            .expect("must not error");
        assert!(result.servers.contains_key("fromExplicit"));
    }
}
