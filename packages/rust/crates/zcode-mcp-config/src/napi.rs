/**
 * napi surface for `zcode-mcp-config`.
 *
 * Spec: docs/specs/rust-native-mcp-config.md §18.
 *
 * This module exists for one reason: `migrate_legacy_common_mcp` was unreachable from Node while a
 * complete JavaScript implementation of it sat next to it in `mcpUserDirectory/legacy.ts`. The
 * algorithm was already correct in Rust; the missing piece was `require()`-ability, so the crate
 * gained a cdylib and that file was deleted.
 *
 * The boundary is a single JSON string, like `zcode-events` §3.3 and `zcode-task-index`: the
 * request and result types are declared in `@zcode/shared`, and redeclaring them here would be a
 * second source of truth for a wire contract.
 */
use napi::bindgen_prelude::{AsyncTask, Env, Error, Result, Task};
use napi_derive::napi;

use crate::legacy::migrate_legacy_common_mcp as run_migration;

/// The four environment inputs, as they come off the wire.
///
/// Every optional field is `Option` because **napi's `FromNapiValue` does not honour
/// `#[serde(default)]`** — a non-`Option` field is simply required, and omitting it fails with
/// "Missing field" rather than falling back to a default. The host always sends all four.
#[napi(object)]
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrateRequest {
    /// An explicit `legacyStorageDir` from the caller; it wins over the derived candidates.
    pub legacy_storage_dir: Option<String>,
    /// `process.env.LOCALAPPDATA`.
    pub local_app_data: Option<String>,
    /// `process.env.APPDATA`.
    pub app_data: Option<String>,
    /// `os.homedir()`.
    pub home: String,
}

/// The result's wire shape.
///
/// Declared here rather than reusing `legacy::MigrationResult` because that is a domain type
/// whose `servers` is a `serde_json::Map`, and the contract with `@zcode/shared` is a JSON object
/// either way. `total_count` and friends are `usize`; a count is never negative, so the wire type
/// is a number without loss.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Outcome {
    servers: serde_json::Value,
    /// Optional, and **omitted rather than sent as `""`**.
    ///
    /// The original returns `{ servers: {}, totalCount: 0, … }` with no `sourcePath` key at all
    /// when nothing is found, and `@zcode/shared` declares it `sourcePath?: string`. Emitting `""`
    /// would claim the servers were found at the empty path — a different statement — and it
    /// breaks `result.sourcePath === undefined`. The end-to-end check is what caught this.
    #[serde(skip_serializing_if = "Option::is_none")]
    source_path: Option<String>,
    total_count: usize,
    imported_count: usize,
    skipped_count: usize,
}

/// Reads `request_json` and returns the migration result as JSON.
///
/// Returns a `Task`-backed handle, not a blocking function: this walks a directory tree and reads
/// every `.ldb`/`.log` file in it, which can be tens of megabytes on a real profile. On the
/// event loop that would freeze the Electron main process — the very process that has to stay
/// responsive to window and IPC events. The work runs on libuv's threadpool instead.
///
/// An `AsyncTask` rather than an `async fn` on purpose: the latter would pull in napi's `async`
/// feature and a Tokio runtime for a single function, and `zcode-task-index` already established
/// `AsyncTask` as this workspace's pattern for the same problem.
///
/// "Nothing found" is an empty result, **not** an error — most machines have no legacy MCP data,
/// and that must not read as a failure.
#[napi]
pub fn migrate_legacy_common_mcp(request_json: String) -> AsyncTask<MigrateTask> {
    // `AsyncTask` is the `ToNapiValue` wrapper around a `Task`: returning the bare `MigrateTask`
    // fails with "the trait bound `MigrateTask: ToNapiValue` is not satisfied".
    AsyncTask::new(MigrateTask { request_json })
}

/// The blocking half of [`migrate_legacy_common_mcp`], run on libuv's threadpool.
pub struct MigrateTask {
    request_json: String,
}

impl Task for MigrateTask {
    type Output = String;
    type JsValue = String;

    fn resolve(
        &mut self,
        _env: Env,
        output: Self::Output,
    ) -> std::result::Result<Self::JsValue, Error> {
        Ok(output)
    }

    fn compute(&mut self) -> Result<Self::Output> {
        let request: MigrateRequest = serde_json::from_str(&self.request_json)
            .map_err(|error| Error::from_reason(format!("invalid migrate request: {error}")))?;

        let result = run_migration(
            request.legacy_storage_dir.as_deref(),
            request.local_app_data.as_deref(),
            request.app_data.as_deref(),
            &request.home,
        )
        .map_err(|error| Error::from_reason(error.to_string()))?;

        let outcome = Outcome {
            servers: serde_json::Value::Object(result.servers),
            source_path: if result.source_path.is_empty() {
                None
            } else {
                Some(result.source_path)
            },
            total_count: result.total_count,
            imported_count: result.imported_count,
            skipped_count: result.skipped_count,
        };

        serde_json::to_string(&outcome)
            .map_err(|error| Error::from_reason(format!("cannot serialise the result: {error}")))
    }
}

#[cfg(test)]
mod tests {
    use super::{MigrateRequest, Outcome};

    #[test]
    fn a_request_deserialises_from_the_shared_wire_shape() {
        let request: MigrateRequest = serde_json::from_str(
            r#"{"legacyStorageDir":"/tmp/a","localAppData":"/tmp/l","appData":"/tmp/r","home":"/home/u"}"#,
        )
        .expect("deserialize");
        assert_eq!(request.legacy_storage_dir.as_deref(), Some("/tmp/a"));
        assert_eq!(request.local_app_data.as_deref(), Some("/tmp/l"));
        assert_eq!(request.app_data.as_deref(), Some("/tmp/r"));
        assert_eq!(request.home, "/home/u");
    }

    /// An **empty but present** environment variable must arrive as `Some("")`, not `None`.
    ///
    /// The original is `process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")`, and `??`
    /// only falls through on `null`/`undefined` — so `LOCALAPPDATA=""` is used as-is and produces
    /// relative candidate paths. Treating `""` as absent would search a different place on a
    /// misconfigured machine, which is a silent difference in what gets migrated.
    #[test]
    fn an_empty_but_present_variable_is_not_absent() {
        let request: MigrateRequest = serde_json::from_str(
            r#"{"legacyStorageDir":null,"localAppData":"","appData":null,"home":"/h"}"#,
        )
        .expect("deserialize");
        assert_eq!(
            request.local_app_data.as_deref(),
            Some(""),
            "an empty LOCALAPPDATA is a real value, not a missing one"
        );
        assert_eq!(request.app_data, None, "an absent variable stays absent");
    }

    /// An unknown key is a hard error, not a silent drop.
    ///
    /// A typo like `legacyStoragePath` would otherwise leave the caller's real directory unused,
    /// and the migration would read the wrong place while reporting success.
    #[test]
    fn an_unknown_field_is_rejected() {
        let error =
            serde_json::from_str::<MigrateRequest>(r#"{"legacyStoragePath":"/tmp/a","home":"/h"}"#)
                .expect_err("must reject an unknown field");
        assert!(error.to_string().contains("legacyStoragePath"), "{error}");
    }

    /// The result serialises with **camelCase** keys, matching `MigrateLegacyCommonMcpResult`.
    ///
    /// `source_path` → `sourcePath` is the whole test: a snake_case key here would leave every
    /// field `undefined` on the TypeScript side, and the renderer would show an empty server list
    /// with no error anywhere.
    #[test]
    fn the_outcome_serialises_camel_case() {
        let json = serde_json::to_string(&Outcome {
            servers: serde_json::json!({ "fs": { "command": "npx" } }),
            source_path: Some("/tmp/store.json".to_string()),
            total_count: 1,
            imported_count: 0,
            skipped_count: 0,
        })
        .expect("serialise");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("parse");
        assert_eq!(parsed["sourcePath"], "/tmp/store.json");
        assert_eq!(parsed["totalCount"], 1);
        assert_eq!(parsed["importedCount"], 0);
        assert_eq!(parsed["skippedCount"], 0);
        assert_eq!(parsed["servers"]["fs"]["command"], "npx");
    }

    /// "Nothing found" omits `sourcePath` entirely, rather than sending `""`.
    #[test]
    fn an_empty_source_path_is_omitted_not_blank() {
        let json = serde_json::to_string(&Outcome {
            servers: serde_json::json!({}),
            source_path: None,
            total_count: 0,
            imported_count: 0,
            skipped_count: 0,
        })
        .expect("serialise");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("parse");
        assert!(
            parsed.get("sourcePath").is_none(),
            "the key must be absent, not empty: {json}"
        );
        assert_eq!(parsed["totalCount"], 0);
    }
}
