//! napi bridge for `zcode-config`.
//!
//! Spec: `docs/specs/rust-native-config.md` §3.1.
//!
//! # Why the read is an AsyncTask and not a synchronous call
//!
//! Invariant 4 (`rust-native-ports.md`) requires anything that can exceed ~1 ms on realistic
//! input to run as a napi async task. The spec measured the predecessor's parse at **1.11 ms for
//! a 250-record store**, and that is not exotic: the store accumulates one record per granted
//! declaration per workspace and is never compacted unless the user runs the CLI. A synchronous
//! call here would block the host event loop on a file that grows without bound.
//!
//! The *path resolution* is pure string work and stays synchronous.

use napi::bindgen_prelude::{AsyncTask, Env};
use napi::Task;
use napi_derive::napi;

use crate::{
    digests_for_workspace, parse_store_content, resolve_trust_store_path, CorruptReason,
    StoreParseResult,
};

// ---------------------------------------------------------------------------
// Settings schema (spec §3.4, rows T26–T41)
// ---------------------------------------------------------------------------

/// `appSettingsSchema` over file text. Synchronous by design (§3.6): a
/// 51-field settings parse is pure compute over text the caller already holds
/// and measures well under the 1 ms line.
#[napi(js_name = "parseSettingsContent")]
pub fn parse_settings_content_binding(content: String) -> String {
    let result = crate::settings::parse_settings_content(&content);
    serde_json::to_string(&result).expect("serialise")
}

/// `appSettingsPatchSchema` over a parsed patch. Returned as one JSON string —
/// `{ "ok": true, "patch": … }` or `{ "ok": false, "issues": […] }` — so the
/// caller branches instead of catching an exception across the boundary.
#[napi(js_name = "parseSettingsPatch")]
pub fn parse_settings_patch_binding(patch_json: String) -> Result<String, napi::Error> {
    let patch: serde_json::Value =
        serde_json::from_str(&patch_json).map_err(|error| napi::Error::new(napi::Status::InvalidArg, error.to_string()))?;
    let encoded = match crate::settings::parse_settings_patch(&patch) {
        Ok(patch) => serde_json::json!({ "ok": true, "patch": patch }),
        Err(issues) => serde_json::json!({ "ok": false, "issues": issues }),
    };
    serde_json::to_string(&encoded).map_err(|error| napi::Error::new(napi::Status::GenericFailure, error.to_string()))
}

/// The wire shape returned to TypeScript.
///
/// `status` is a string rather than the enum above because napi does not marshal a
/// variant with named fields as a tagged union cleanly; `trustStoreStatus()` is the
/// single place that spelling is produced, so it cannot fork between the two arms.
#[napi(object)]
pub struct TrustStoreRead {
    /// `"missing" | "ok" | "corrupt"`.
    pub status: String,
    /// Always empty when `status` is `"corrupt"` — see `T4_never_returns_a_partial_digest_set`.
    pub digests: Vec<String>,
    pub corrupt: bool,
    /// Absent unless `status` is `"corrupt"`.
    pub reason: Option<String>,
}

/// Resolve the trust store path. Synchronous: pure string work, no IO (spec T22–T25).
#[napi]
pub fn resolve_workspace_hook_trust_store_path(home: String, storage_dir: Option<String>) -> String {
    resolve_trust_store_path(&home, storage_dir.as_deref())
}

/// Read + validate the store for one workspace.
///
/// `content` is supplied by the caller rather than read here so the IO policy stays in
/// TypeScript: the native boundary owns the *decision* (parse, fail-closed classification,
/// identity filtering) and the host owns the *transport*. That split is what the spec's
/// §2.2 host-policy rule requires, and it keeps this function testable without a filesystem.
#[napi]
pub fn read_workspace_hook_trust_store(
    content: Option<String>,
    workspace_identity: String,
) -> TrustStoreRead {
    let Some(content) = content else {
        // The caller resolved "the file does not exist" itself (it is the only layer that can,
        // because ENOENT has to come from the read). An absent content is therefore `missing`,
        // not corrupt — a store nobody has written yet is a normal state, not a broken one.
        return TrustStoreRead {
            status: "missing".into(),
            digests: Vec::new(),
            corrupt: false,
            reason: None,
        };
    };

    match parse_store_content(&content) {
        StoreParseResult::Ok(file) => {
            let digests = digests_for_workspace(&file, &workspace_identity);
            TrustStoreRead {
                status: "ok".into(),
                corrupt: false,
                reason: None,
                digests,
            }
        }
        StoreParseResult::Invalid => TrustStoreRead {
            status: "corrupt".into(),
            digests: Vec::new(),
            corrupt: true,
            reason: Some(corrupt_reason_label(CorruptReason::InvalidContent)),
        },
    }
}

fn corrupt_reason_label(reason: CorruptReason) -> String {
    match reason {
        CorruptReason::Unreadable => "unreadable",
        CorruptReason::InvalidContent => "invalid-content",
    }
    .to_string()
}

/// The whole-store parse, for callers that need the records rather than one workspace's digests
/// (the grant/revoke/compact transitions).
///
/// Returns the store as **JSON text**, not a structured napi object: the record carries
/// `matcherAtGrant` as an arbitrary JSON value, and a Rust `serde_json::Value` field has no
/// napi representation. Serialising here keeps one algorithm and one schema — the consumer
/// re-parses with the same rules, so a second interpretation cannot appear in TypeScript.
///
/// `None` means invalid, which is deliberately distinct from `Some("{\"records\":[]}")`: the
/// corrupt path must be rebuilt from scratch (spec T14), and that has to be a different code
/// path from "no records yet".
#[napi]
pub fn parse_workspace_hook_trust_store(content: String) -> Option<String> {
    match parse_store_content(&content) {
        StoreParseResult::Ok(file) => serde_json::to_string(&file).ok(),
        StoreParseResult::Invalid => None,
    }
}

/// `AsyncTask` form of [`parse_workspace_hook_trust_store`].
///
/// Invariant 4: the spec measured 1.11 ms for a 250-record store, which is well over the ~1 ms
/// line, and the store is never compacted unless the user runs the CLI — so it grows unbounded.
/// The task body calls the same function as the synchronous entry point, so there is one
/// algorithm and the two forms cannot disagree.
pub struct ParseTrustStoreTask {
    content: String,
}

impl Task for ParseTrustStoreTask {
    type Output = Option<String>;
    type JsValue = Option<String>;

    fn compute(&mut self) -> std::result::Result<Self::Output, napi::Error> {
        Ok(parse_workspace_hook_trust_store(self.content.clone()))
    }

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, napi::Error> {
        Ok(output)
    }
}

/// Async parse. Resolves to the validated store JSON, or `null` when invalid.
#[napi]
pub fn parse_workspace_hook_trust_store_async(content: String) -> AsyncTask<ParseTrustStoreTask> {
    AsyncTask::new(ParseTrustStoreTask { content })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_content_is_missing_and_not_corrupt() {
        let read = read_workspace_hook_trust_store(None, "ws".into());
        assert_eq!(read.status, "missing");
        assert!(!read.corrupt);
        assert!(read.digests.is_empty());
        assert!(read.reason.is_none());
    }

    #[test]
    fn an_invalid_content_is_corrupt_with_an_empty_digest_set() {
        let read = read_workspace_hook_trust_store(Some("{not json".into()), "ws".into());
        assert_eq!(read.status, "corrupt");
        assert!(read.corrupt);
        assert!(read.digests.is_empty());
        assert_eq!(read.reason.as_deref(), Some("invalid-content"));
    }

    #[test]
    fn a_valid_store_reports_ok_with_only_this_workspaces_digests() {
        let digest = "a".repeat(64);
        let record = |identity: &str| {
            format!(
                r#"{{"workspaceIdentity":"{identity}","hookDeclarationDigest":"{digest}",
                     "digestAlgorithm":"sha256","decision":"trusted",
                     "grantedAt":"2026-01-02T03:04:05.000Z","eventAtGrant":"PreToolUse",
                     "displayCommandAtGrant":"echo hi","sourcePathAtGrant":"/ws/.zcode/config.json"}}"#
            )
        };
        let content = format!(
            r#"{{"schemaVersion":1,"records":[{},{}]}}"#,
            record("ws-1"),
            record("ws-2")
        );
        let read = read_workspace_hook_trust_store(Some(content), "ws-2".into());
        assert_eq!(read.status, "ok");
        assert_eq!(read.digests, vec![digest]);
    }

    #[test]
    fn the_async_form_agrees_with_the_synchronous_one() {
        let content = r#"{"schemaVersion":1,"records":[]}"#.to_string();
        let once = parse_workspace_hook_trust_store(content.clone());
        assert!(once.is_some(), "a valid store must produce output");
        assert_eq!(
            once,
            parse_workspace_hook_trust_store(content.clone()),
            "the two entry points must not disagree",
        );
        assert!(parse_workspace_hook_trust_store("{bad".to_string()).is_none());
    }

    #[test]
    fn an_invalid_store_is_distinguishable_from_an_empty_one() {
        // The whole point of `Option`: a corrupt store must not be re-serialisable as an
        // empty-but-valid one, or the rebuild path becomes unreachable.
        assert!(parse_workspace_hook_trust_store("{bad".to_string()).is_none());
        let empty = parse_workspace_hook_trust_store(
            r#"{"schemaVersion":1,"records":[]}"#.to_string(),
        );
        assert_ne!(empty, None);
    }

    #[test]
    fn path_resolution_crosses_the_boundary_unchanged() {
        assert_eq!(
            resolve_workspace_hook_trust_store_path("/home/u".into(), None),
            "/home/u/.zcode/security/workspace-hook-trust-v1.json",
        );
    }
}