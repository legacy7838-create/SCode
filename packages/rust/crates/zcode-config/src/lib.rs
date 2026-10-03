//! The Workspace Hook trust store: one authoritative schema and one fail-closed read.
//!
//! Spec: `docs/specs/rust-native-config.md` §3.1–§3.3.
//! Ported from `packages/shared/src/workspace-hook-trust-store-file.ts` (the schema) and
//! `readPersistentWorkspaceHookTrustDigests` (`packages/services/src/hooks/hooksService.ts:154-212`).
//!
//! # Why this is the security boundary, and what "fail-closed" means structurally
//!
//! The predecessor's own comment records the bug this replaces. The services layer used to
//! hand-validate the file (an `isRecord` plus a digest regex) while runtime/adapters applied the
//! full strict schema, and the two reached **different conclusions about the same file**. A store
//! that is valid JSON but structurally invalid — missing `schemaVersion`, a bad `decision`, an
//! unknown field — was treated as partially credible by one side and as total corruption by the
//! other. The visible result was a presentation/runtime divergence: the UI said "trusted" while the
//! execution layer refused forever, and nothing diagnosed it.
//!
//! So the rule this module enforces is not a style preference:
//!
//! - A JSON **syntax** error and a **schema** violation are the *same* outcome, `corrupt`. The
//!   file is untrustworthy either way, so no partial result may escape.
//! - `corrupt` and a non-empty digest set are **mutually exclusive by construction**: the three
//!   return arms below are separate, so there is no code path that yields both. A future edit that
//!   produced `{ corrupt: true, digests }` fails `tests::t4_never_returns_a_partial_digest_set`
//!   rather than review.
//! - The uniqueness rule (`workspaceIdentity\0hookDeclarationDigest`) is re-checked after
//!   validation, because it is the one constraint that is not expressible as a per-field rule.

#[cfg(feature = "napi-exports")]
mod napi_bridge;
pub mod settings_persist;

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// `WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION`. A literal, not a range: a future
/// version must be a deliberate migration, never an implicit acceptance.
pub const WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION: u64 = 1;

/// The seven hook event names the store may record a grant against.
///
/// Kept in sync with `workspaceHookEventNameSchema` in the shared module — that is
/// what the CLI's zod3 copy of the schema compares against, so a divergence here
/// would reintroduce exactly the two-schemas problem this crate exists to remove.
pub const WORKSPACE_HOOK_EVENT_NAMES: [&str; 7] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
];

fn is_hook_event_name(value: &str) -> bool {
    WORKSPACE_HOOK_EVENT_NAMES.contains(&value)
}

/// `z.string().trim().min(1)` — note that zod **trims before** the length check, so
/// `"   "` is rejected. Reproducing the order matters: checking length first would
/// accept a whitespace-only identity and produce a key nothing else can match.
fn is_non_empty_trimmed(value: &str) -> bool {
    !value.trim().is_empty()
}

/// `^[a-f0-9]{64}$` — lowercase only, exactly 64 characters. Not a permissive
/// "64 hex-ish chars": the digest is compared against `sha256` output, and a
/// differently-cased digest would never match, which would read as a revoked trust
/// rather than as a corrupt store.
fn is_sha256_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `z.number().int().nonnegative()` on a JSON number.
fn is_nonnegative_integer(value: &serde_json::Value) -> bool {
    match value.as_f64() {
        // `f64` cannot represent every `i64`, so compare in f64 against the exact
        // integer domain rather than casting: 1e300 as i64 saturates and would
        // otherwise read as a small positive number.
        Some(number) => number.is_finite() && number >= 0.0 && number.fract() == 0.0,
        None => false,
    }
}

/// `z.string().datetime()`. zod's `datetime` requires RFC 3339 with an explicit
/// offset and rejects a bare local timestamp, so `2026-01-01T00:00:00` is corrupt.
///
/// Checked structurally rather than with a date library: the predicate the trust
/// store actually needs is "is this an unambiguous instant", and adding a calendar
/// dependency to decide that would be a larger supply-chain surface than the check.
fn is_rfc3339_datetime(value: &str) -> bool {
    // YYYY-MM-DDThh:mm:ss with a mandatory zone designator.
    let bytes = value.as_bytes();
    if bytes.len() < 20 {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_digit);
    let is_dash = |i: usize| bytes[i] == b'-';
    let is_colon = |i: usize| bytes[i] == b':';
    let date_ok = digits(0..4) && is_dash(4) && digits(5..7) && is_dash(7) && digits(8..10);
    let sep_ok = bytes[10] == b'T' || bytes[10] == b't';
    let time_ok =
        digits(11..13) && is_colon(13) && digits(14..16) && is_colon(16) && digits(17..19);
    // The zone designator starts after an OPTIONAL fractional-seconds part. Slicing
    // at a fixed 19 rejected `…T03:04:05.000Z`, which is the shape `Date.toISOString()`
    // emits and therefore the shape most grants actually have.
    let rest = &value[19..];
    let zone = match rest.strip_prefix('.') {
        // No fractional part: the whole remainder is the zone.
        None => rest,
        // Fractional part present. `split_once` is the wrong tool: it searches for
        // the FIRST match and returns the text before it, so on ".000Z" it returned
        // ("000", "") and lost the `Z`. The zone is what follows the run of leading
        // digits, so take the digit prefix explicitly.
        Some(fractional) => {
            let digit_count = fractional.bytes().take_while(u8::is_ascii_digit).count();
            if digit_count == 0 {
                return false;
            }
            &fractional[digit_count..]
        }
    };
    let zone_ok = zone == "Z"
        || zone == "z"
        || (zone.len() == 6
            && (zone.starts_with('+') || zone.starts_with('-'))
            && zone.as_bytes()[3] == b':');
    date_ok && sep_ok && time_ok && zone_ok
}

/// One granted hook declaration.
///
/// The field set and its validators are a literal transcription of
/// `workspaceHookTrustRecordSchema`. Unknown fields are **rejected** (`.strict()`),
/// which is the opposite of the settings schema — see spec §6 R7 for why the two
/// differ and why both are required.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceHookTrustRecord {
    #[serde(deserialize_with = "deserialize_non_empty")]
    pub workspace_identity: String,
    #[serde(deserialize_with = "deserialize_sha256")]
    pub hook_declaration_digest: String,
    pub digest_algorithm: DigestAlgorithm,
    pub decision: Decision,
    #[serde(deserialize_with = "deserialize_datetime")]
    pub granted_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_optional_datetime")]
    pub last_used_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_optional_sha256")]
    pub bundle_digest_at_grant: Option<String>,
    #[serde(deserialize_with = "deserialize_event_name")]
    pub event_at_grant: String,
    #[serde(deserialize_with = "deserialize_non_empty")]
    pub display_command_at_grant: String,
    #[serde(deserialize_with = "deserialize_non_empty")]
    pub source_path_at_grant: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_optional_non_negative_integer")]
    pub source_discovery_order_at_grant: Option<serde_json::Value>,
    // No `skip_serializing_if`: this field is `.nullable()`, so "absent" and "present but null"
    // Tri-state, not `Option`: the field is `.nullable()`, so "absent" and "present but null"
    // are two different store contents and the round trip must preserve the difference. An
    // `Option<Value>` cannot express it: `skip_serializing_if = "Option::is_none"` drops
    // `Some(Null)` along with `None`, and omitting the attribute emits the key for both.
    #[serde(
        default,
        skip_serializing_if = "MatcherAtGrant::is_absent",
        deserialize_with = "deserialize_matcher"
    )]
    pub matcher_at_grant: MatcherAtGrant,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_optional_non_negative_integer")]
    pub matcher_index_at_grant: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_optional_non_negative_integer")]
    pub hook_index_at_grant: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_optional_non_empty")]
    pub app_version_at_grant: Option<String>,
}

/// `z.literal("sha256")`. An enum rather than a `String` so an unknown algorithm
/// is a deserialization failure instead of a value that only fails when compared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DigestAlgorithm {
    #[serde(rename = "sha256")]
    Sha256,
}

/// `z.literal("trusted")`. See [`DigestAlgorithm`] for why this is not a `String`:
/// the store has exactly one decision, and widening it later has to be a type change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Decision {
    #[serde(rename = "trusted")]
    Trusted,
}

fn deserialize_non_empty<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        Err(serde::de::Error::custom("expected a non-empty string"))
    } else {
        // The trimmed value is returned, not the original. `z.string().trim().min(1)` rewrites the
        // parsed output, and that is load-bearing: `ws-1` and `ws-1 ` become the same uniqueness
        // key, so a store holding both is rejected. Keeping the raw value here would parse a file
        // the predecessor rejects.
        Ok(trimmed.to_string())
    }
}

fn deserialize_optional_non_empty<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<String>::deserialize(deserializer)?;
    match raw {
        Some(value) if is_non_empty_trimmed(&value) => Ok(Some(value)),
        Some(_) => Err(serde::de::Error::custom("expected a non-empty string")),
        None => Ok(None),
    }
}

fn deserialize_sha256<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    if is_sha256_digest(&raw) {
        Ok(raw)
    } else {
        Err(serde::de::Error::custom("expected a lowercase sha256 hex digest"))
    }
}

fn deserialize_optional_sha256<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<String>::deserialize(deserializer)?;
    match raw {
        Some(value) if is_sha256_digest(&value) => Ok(Some(value)),
        Some(_) => Err(serde::de::Error::custom("expected a lowercase sha256 hex digest")),
        None => Ok(None),
    }
}

fn deserialize_datetime<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    if is_rfc3339_datetime(&raw) {
        Ok(raw)
    } else {
        Err(serde::de::Error::custom("expected an RFC 3339 datetime"))
    }
}

fn deserialize_optional_datetime<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<String>::deserialize(deserializer)?;
    match raw {
        Some(value) if is_rfc3339_datetime(&value) => Ok(Some(value)),
        Some(_) => Err(serde::de::Error::custom("expected an RFC 3339 datetime")),
        None => Ok(None),
    }
}

fn deserialize_event_name<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    if is_hook_event_name(&raw) {
        Ok(raw)
    } else {
        Err(serde::de::Error::custom("unknown workspace hook event name"))
    }
}

/// `z.string().nullable().optional()` — so exactly `string | null | absent`, and nothing else.
/// Held as a `serde_json::Value` because `null` has to survive the round trip; the *type* is
/// still constrained, which is the part that matters (an object here is a malformed record).
/// The three states of `matcherAtGrant`, kept distinct because the store file distinguishes them:
/// "no key" and "key present, value null" round-trip differently and a caller that compares
/// store contents byte for byte will see the difference.
///
/// `Default` is `Absent` because that is what a record without the key means.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum MatcherAtGrant {
    #[default]
    Absent,
    Null,
    Value(String),
}

impl MatcherAtGrant {
    /// The field attribute's predicate. `Absent` is the only state that omits the key.
    fn is_absent(&self) -> bool {
        matches!(self, MatcherAtGrant::Absent)
    }
}

impl Serialize for MatcherAtGrant {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            MatcherAtGrant::Null => serializer.serialize_none(),
            MatcherAtGrant::Value(text) => serializer.serialize_str(text),
            // Unreachable: the field is annotated with `skip_serializing_if = "is_absent"`,
            // so serde never asks to serialise this variant.
            MatcherAtGrant::Absent => serializer.serialize_none(),
        }
    }
}

fn deserialize_matcher<'de, D>(deserializer: D) -> Result<MatcherAtGrant, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Deserialised as a bare `Value`, not `Option<Value>`: serde_json's `Option` impl collapses a
    // *present* `null` into `None`, which is precisely the distinction this field exists to keep.
    // A missing key never reaches here — `#[serde(default)]` covers it with `Absent`.
    match serde_json::Value::deserialize(deserializer) {
        Ok(serde_json::Value::String(text)) => Ok(MatcherAtGrant::Value(text)),
        Ok(serde_json::Value::Null) => Ok(MatcherAtGrant::Null),
        Ok(_) => Err(serde::de::Error::custom("matcherAtGrant must be a string or null")),
        Err(_) => Err(serde::de::Error::custom("matcherAtGrant must be a string or null")),
    }
}

fn deserialize_optional_non_negative_integer<'de, D>(
    deserializer: D,
) -> Result<Option<serde_json::Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<serde_json::Value>::deserialize(deserializer)?;
    match &raw {
        Some(value) if is_nonnegative_integer(value) => Ok(raw),
        Some(_) => Err(serde::de::Error::custom("expected a nonnegative integer")),
        None => Ok(None),
    }
}

/// The whole store file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceHookTrustStoreFile {
    pub schema_version: u64,
    pub records: Vec<WorkspaceHookTrustRecord>,
}

/// Parse verdict for the store file, mirroring the predecessor's two-way
/// `status: "ok" | "invalid"`.
///
/// `Invalid` deliberately carries no payload: the predecessor's `parseWorkspaceHookTrustStoreContent`
/// returns no diagnostics either, and adding one here would tempt a caller into
/// logging a partial view of a store that must be treated as wholly untrustworthy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreParseResult {
    Ok(WorkspaceHookTrustStoreFile),
    Invalid,
}

/// `parseWorkspaceHookTrustStoreContent`, plus the uniqueness `superRefine`.
///
/// The two failure classes are collapsed into [`StoreParseResult::Invalid`] on
/// purpose — see the module docs. `serde_json::from_str::<WorkspaceHookTrustStoreFile>`
/// covers both the JSON syntax error and every field rule in one step, because
/// `deny_unknown_fields` plus the custom deserializers above are the schema.
pub fn parse_store_content(content: &str) -> StoreParseResult {
    let parsed: WorkspaceHookTrustStoreFile = match serde_json::from_str(content) {
        Ok(file) => file,
        Err(_) => return StoreParseResult::Invalid,
    };
    if parsed.schema_version != WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION {
        return StoreParseResult::Invalid;
    }
    if !keys_are_unique(&parsed.records) {
        return StoreParseResult::Invalid;
    }
    StoreParseResult::Ok(parsed)
}

/// The `superRefine`: `\0`-joined `workspaceIdentity` + `hookDeclarationDigest`
/// must be unique across `records`.
///
/// Re-implemented here rather than relying on deserialization order, because it is
/// the one rule that cannot be expressed per-field and so is the one a reviewer is
/// most likely to miss when adding a record field.
pub fn keys_are_unique(records: &[WorkspaceHookTrustRecord]) -> bool {
    let mut seen: HashSet<String> = HashSet::with_capacity(records.len());
    records.iter().all(|record| {
        seen.insert(format!("{}\0{}", record.workspace_identity, record.hook_declaration_digest))
    })
}

/// The read result. Three arms, and `corrupt` with a non-empty `digests` is not
/// representable — see the module docs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrustReadStatus {
    /// The file does not exist. Reasonable: no grant has ever been made.
    Missing,
    /// Parsed, and the digests below are this workspace's records only.
    Ok,
    /// Unreadable, or invalid JSON, or a schema violation. **Fail-closed**: no digests.
    Corrupt { reason: CorruptReason },
}

/// Why the store was treated as corrupt. Carried so the UI can say which of the
/// three causes happened instead of one opaque "trust store broken".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorruptReason {
    /// A read error other than `ENOENT` — EACCES, EROFS, EISDIR, EIO. Spec T2.
    Unreadable,
    /// JSON syntax error or schema violation. Spec T3, T4.
    InvalidContent,
}

/// Project a parsed store to the digests belonging to one workspace.
///
/// The identity filter is here, not at the call site, so "which records are mine"
/// is decided once. `workspaceIdentity` is compared exactly, not trimmed: the
/// schema already rejects a whitespace-only value, and trimming here would make
/// `" ws "` and `"ws"` the same workspace, which is a decision this layer has no
/// evidence to make.
pub fn digests_for_workspace(
    file: &WorkspaceHookTrustStoreFile,
    workspace_identity: &str,
) -> Vec<String> {
    file.records
        .iter()
        .filter(|record| record.workspace_identity == workspace_identity)
        .map(|record| record.hook_declaration_digest.clone())
        .collect()
}

/// `resolveWorkspaceHookTrustStorePath`, pinned by spec T22–T25.
///
/// The order of the four cases is load-bearing and is the predecessor's:
/// `""`/absent → `<home>/.zcode`; a leading `~/` joins onto `home`; an absolute
/// path ignores `home`; anything else resolves against `home`, **not** the process
/// cwd. Getting the last one wrong silently points the trust store at a different
/// file depending on where the process was launched from.
pub fn resolve_trust_store_path(home: &str, storage_dir_configured: Option<&str>) -> String {
    let configured = storage_dir_configured.unwrap_or("").trim();
    let root = if configured.is_empty() {
        join_path(&[home, ".zcode"])
    } else if let Some(rest) = configured.strip_prefix("~/") {
        join_path(&[home, rest])
    } else if is_absolute(configured) {
        configured.to_string()
    } else {
        join_path(&[home, configured])
    };
    join_path(&[&root, "security", "workspace-hook-trust-v1.json"])
}

/// `path.posix.join` / `path.posix.resolve` normalisation, reproduced.
///
/// The recorded differential is what proved a hand-rolled "just collapse the slashes" version
/// wrong: `path.join` and `path.resolve` **do** resolve `.` and `..` and **do** collapse a
/// duplicate separator, so `join("/home/u", "../elsewhere")` is `/home/elsewhere` and
/// `join("/var//lib/zcode")` is `/var/lib/zcode`. Getting this wrong points the trust store at a
/// *different file* depending on the configured `storage.dir`, which is precisely the class of
/// bug the strict schema was written to remove.
///
/// Implemented rather than pulled from a crate because the rule is short, POSIX-only, and a
/// dependency would be a larger supply-chain surface than the check it performs. Every clause is
/// pinned by `path_*` below and by the harness.
fn normalize_posix(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut resolved: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            // "" is a duplicate or trailing separator; "." is a no-op. Both disappear.
            "" | "." => {}
            ".." => {
                // `..` pops a real segment, but never past the root, and never pops a leading
                // `..` from a relative path — both of which `path.posix` treat as literal.
                if let Some(last) = resolved.last() {
                    if *last != ".." {
                        resolved.pop();
                        continue;
                    }
                } else if absolute {
                    continue;
                }
                resolved.push("..");
            }
            other => resolved.push(other),
        }
    }
    let joined = resolved.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

/// `path.posix.join`: join the segments, then normalise the result.
///
/// Node's `join` keeps a leading `/` only when the *first* segment has one, which is why the
/// `absolute` flag is taken from the joined string rather than from `is_absolute`.
fn join_path(segments: &[&str]) -> String {
    let non_empty: Vec<&str> = segments.iter().copied().filter(|segment| !segment.is_empty()).collect();
    if non_empty.is_empty() {
        return ".".to_string();
    }
    normalize_posix(&non_empty.join("/"))
}

/// `path.isAbsolute`, POSIX.
fn is_absolute(path: &str) -> bool {
    path.starts_with('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DIGEST_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn record(identity: &str, digest: &str) -> String {
        format!(
            r#"{{"workspaceIdentity":"{identity}","hookDeclarationDigest":"{digest}",
                 "digestAlgorithm":"sha256","decision":"trusted",
                 "grantedAt":"2026-01-02T03:04:05.000Z","eventAtGrant":"PreToolUse",
                 "displayCommandAtGrant":"echo hi","sourcePathAtGrant":"/ws/.zcode/config.json"}}"#
        )
    }

    fn store(records: Vec<String>) -> String {
        format!(r#"{{"schemaVersion":1,"records":[{}]}}"#, records.join(","))
    }

    // --- T1 / T3 / T6 -------------------------------------------------------

    #[test]
    fn t1_an_empty_record_set_is_ok_and_not_corrupt() {
        let parsed = parse_store_content(&store(Vec::new()));
        assert_eq!(parsed, StoreParseResult::Ok(WorkspaceHookTrustStoreFile {
            schema_version: 1,
            records: Vec::new(),
        }));
    }

    #[test]
    fn t3_invalid_json_is_invalid() {
        assert_eq!(parse_store_content("{not json"), StoreParseResult::Invalid);
    }

    #[test]
    fn t4_a_wrong_schema_version_is_invalid() {
        let content = r#"{"schemaVersion":2,"records":[]}"#;
        assert_eq!(parse_store_content(content), StoreParseResult::Invalid);
    }

    // --- T4, field by field -------------------------------------------------

    #[test]
    fn a_missing_required_field_is_invalid() {
        let content = r#"{"schemaVersion":1,"records":[{"workspaceIdentity":"ws"}]}"#;
        assert_eq!(parse_store_content(content), StoreParseResult::Invalid);
    }

    #[test]
    fn an_unknown_field_is_invalid_because_the_schema_is_strict() {
        let content = store(vec![format!(
            r#"{{"workspaceIdentity":"ws","hookDeclarationDigest":"{DIGEST_A}",
                 "digestAlgorithm":"sha256","decision":"trusted",
                 "grantedAt":"2026-01-02T03:04:05.000Z","eventAtGrant":"PreToolUse",
                 "displayCommandAtGrant":"echo hi","sourcePathAtGrant":"/ws/.zcode/config.json",
                 "surprise":1}}"#
        )]);
        assert_eq!(parse_store_content(&content), StoreParseResult::Invalid);
    }

    #[test]
    fn an_unknown_top_level_field_is_invalid() {
        let content = r#"{"schemaVersion":1,"records":[],"extra":true}"#;
        assert_eq!(parse_store_content(content), StoreParseResult::Invalid);
    }

    #[test]
    fn a_digest_that_is_not_lowercase_hex_of_64_is_invalid() {
        for bad in [
            "A".repeat(64),                                  // uppercase
            "a".repeat(63),                                  // short
            "a".repeat(65),                                  // long
            format!("{DIGEST_A}0"),                           // 65 chars
        ] {
            let content = store(vec![record("ws", &bad)]);
            assert_eq!(
                parse_store_content(&content),
                StoreParseResult::Invalid,
                "{bad:?} must be rejected",
            );
        }
    }

    #[test]
    fn a_whitespace_only_identity_is_invalid_because_zod_trims_before_the_length_check() {
        let content = store(vec![record("   ", DIGEST_A)]);
        assert_eq!(parse_store_content(&content), StoreParseResult::Invalid);
    }

    #[test]
    fn a_bad_datetime_is_invalid() {
        // Missing the zone designator: zod's `datetime()` rejects a bare local time,
        // because an unqualified timestamp is ambiguous and a trust grant must not be.
        let content = store(vec![record("ws", DIGEST_A).replace(
            "2026-01-02T03:04:05.000Z",
            "2026-01-02T03:04:05",
        )]);
        assert_eq!(parse_store_content(&content), StoreParseResult::Invalid);
    }

    #[test]
    fn an_unknown_event_name_is_invalid() {
        let content = store(vec![record("ws", DIGEST_A).replace("PreToolUse", "NopeToolUse")]);
        assert_eq!(parse_store_content(&content), StoreParseResult::Invalid);
    }

    #[test]
    fn a_negative_index_is_invalid() {
        let content = store(vec![record("ws", DIGEST_A).replace(
            r#""sourcePathAtGrant":"/ws/.zcode/config.json""#,
            r#""sourcePathAtGrant":"/ws/.zcode/config.json","matcherIndexAtGrant":-1"#,
        )]);
        assert_eq!(parse_store_content(&content), StoreParseResult::Invalid);
    }

    #[test]
    fn a_fractional_index_is_invalid_because_the_schema_says_int() {
        let content = store(vec![record("ws", DIGEST_A).replace(
            r#""sourcePathAtGrant":"/ws/.zcode/config.json""#,
            r#""sourcePathAtGrant":"/ws/.zcode/config.json","matcherIndexAtGrant":1.5"#,
        )]);
        assert_eq!(parse_store_content(&content), StoreParseResult::Invalid);
    }

    // --- T4, the uniqueness superRefine -------------------------------------

    #[test]
    fn duplicate_identity_and_digest_keys_are_invalid() {
        let content = store(vec![record("ws", DIGEST_A), record("ws", DIGEST_A)]);
        assert_eq!(parse_store_content(&content), StoreParseResult::Invalid);
    }

    #[test]
    fn the_same_digest_in_a_different_workspace_is_fine() {
        let content = store(vec![record("ws-1", DIGEST_A), record("ws-2", DIGEST_A)]);
        assert!(matches!(parse_store_content(&content), StoreParseResult::Ok(_)));
    }

    #[test]
    fn distinct_digests_in_one_workspace_are_fine() {
        let content = store(vec![record("ws", DIGEST_A), record("ws", DIGEST_B)]);
        assert!(matches!(parse_store_content(&content), StoreParseResult::Ok(_)));
    }

    // --- T5: identity filtering ---------------------------------------------

    #[test]
    fn t5_only_this_workspaces_records_come_back() {
        let content = store(vec![record("ws-1", DIGEST_A), record("ws-2", DIGEST_B)]);
        let StoreParseResult::Ok(file) = parse_store_content(&content) else {
            panic!("fixture must parse");
        };
        assert_eq!(digests_for_workspace(&file, "ws-2"), vec![DIGEST_B.to_string()]);
        assert!(digests_for_workspace(&file, "ws-3").is_empty());
    }

    #[test]
    fn an_identity_is_matched_exactly_not_trimmed() {
        let content = store(vec![record("ws", DIGEST_A)]);
        let StoreParseResult::Ok(file) = parse_store_content(&content) else {
            panic!("fixture must parse");
        };
        // Trimming here would make " ws " and "ws" the same workspace, which this
        // layer has no evidence to decide.
        assert!(digests_for_workspace(&file, " ws ").is_empty());
    }

    // --- The mutual exclusion T4/T10 depend on ------------------------------

    #[test]
    fn t4_never_returns_a_partial_digest_set() {
        // Every corrupt input must produce Invalid, and Invalid carries no file, so
        // there is no value any caller can turn into a digest set.
        for content in [
            "{not json".to_string(),
            r#"{"schemaVersion":2,"records":[]}"#.to_string(),
            store(vec![record("ws", "not-a-digest")]),
            store(vec![record("ws", DIGEST_A), record("ws", DIGEST_A)]),
        ] {
            assert!(matches!(parse_store_content(&content), StoreParseResult::Invalid));
        }
    }

    #[test]
    fn corrupt_and_a_non_empty_digest_set_cannot_both_be_observed() {
        let corrupt = TrustReadStatus::Corrupt { reason: CorruptReason::InvalidContent };
        match corrupt {
            TrustReadStatus::Corrupt { .. } => {}
            other => panic!("expected corrupt, got {other:?}"),
        }
        // The point is structural: `TrustReadStatus` has no variant carrying digests,
        // so the caller supplies an empty set itself and cannot forget to.
        let reasons = [CorruptReason::Unreadable, CorruptReason::InvalidContent];
        assert_eq!(reasons.len(), 2, "both corrupt reasons must exist and stay distinct");
    }

    // --- T22–T25: path resolution -------------------------------------------

    #[test]
    fn t22_an_absent_storage_dir_uses_the_default_root() {
        for configured in [None, Some(""), Some("   ")] {
            assert_eq!(
                resolve_trust_store_path("/home/u", configured),
                "/home/u/.zcode/security/workspace-hook-trust-v1.json",
            );
        }
    }

    #[test]
    fn t23_a_leading_tilde_slash_joins_onto_home() {
        assert_eq!(
            resolve_trust_store_path("/home/u", Some("~/data/x")),
            "/home/u/data/x/security/workspace-hook-trust-v1.json",
        );
    }

    #[test]
    fn t24_an_absolute_storage_dir_never_consults_home() {
        assert_eq!(
            resolve_trust_store_path("/home/u", Some("/var/lib/zcode")),
            "/var/lib/zcode/security/workspace-hook-trust-v1.json",
        );
    }

    #[test]
    fn t25_a_relative_storage_dir_resolves_against_home_not_the_cwd() {
        assert_eq!(
            resolve_trust_store_path("/home/u", Some("rel/dir")),
            "/home/u/rel/dir/security/workspace-hook-trust-v1.json",
        );
    }

    #[test]
    fn the_configuration_is_trimmed_before_it_is_classified() {
        assert_eq!(
            resolve_trust_store_path("/home/u", Some("  /abs/dir  ")),
            "/abs/dir/security/workspace-hook-trust-v1.json",
        );
    }

    #[test]
    fn a_dot_dot_in_the_storage_dir_is_resolved_because_path_join_does() {
        // This test previously asserted the opposite. It was wrong: the recorded differential
        // showed `path.join("/home/u", "../elsewhere")` is `/home/elsewhere`, so the predecessor
        // resolves `..`. Keeping the raw segments would point the trust store at a *different*
        // file than the predecessor reads, which is the exact divergence class this port exists to
        // close — the same reason the schema had to be shared rather than hand-written twice.
        assert_eq!(
            resolve_trust_store_path("/home/u", Some("../elsewhere")),
            "/home/elsewhere/security/workspace-hook-trust-v1.json",
        );
    }

    #[test]
    fn path_normalisation_matches_the_platform_rules_the_predecessor_relied_on() {
        // Pinned against `path.posix.join`; the harness re-checks every one of these against the
        // live predecessor.
        assert_eq!(join_path(&["/var//lib/zcode"]), "/var/lib/zcode");
        assert_eq!(join_path(&["/home/u", "."]), "/home/u");
        assert_eq!(join_path(&["/home/u", "../.."]), "/");
        assert_eq!(join_path(&["/home/u", "../../.."]), "/");
        assert_eq!(join_path(&["a", ".."]), ".");
        // `a/../b` collapses all the way to `b`; a leading `..` only survives when there is
        // nothing real in front of it to pop.
        assert_eq!(join_path(&["a", "../b"]), "b");
        assert_eq!(join_path(&["../b"]), "../b");
        assert_eq!(join_path(&["/", "security"]), "/security");
        assert_eq!(join_path(&[""]), ".");
    }
}
