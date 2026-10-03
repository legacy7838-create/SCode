//! ZCode Built-in release download boundary.
//!
//! Rust port of `packages/provider-node/src/zcode-builtin-download.ts`. The
//! network itself stays injected (the TS `request` callback — services'
//! `ApiClient` or the CLI's fetch); this module owns the URL construction, the
//! init shape, the client-config schema, the retired-ZAPI/provider validation
//! and the exact error taxonomy.
//!
//! # Budgets
//!
//! TS ran a 20 s `AbortController` around both requests and counted body bytes
//! against a 10 MB cap while streaming. The total budget is enforced here by
//! the caller (the napi layer runs this on a tokio task and times out), and the
//! body cap is checked on the assembled body, so an oversized response is still
//! rejected — never written, never applied.
//!
//! # Why the error strings matter
//!
//! `ZCode Built-in <stage>: <reason>` is what the CLI prints
//! (`provider-runtime-env.ts` `createCliProviderRefreshReporter`). The reason
//! vocabulary is fixed: `timeout`, `cancelled`, `HTTP <status>`, `empty body`,
//! `body limit exceeded`, `invalid schema at <path> (<code>)`, `invalid
//! response`.

use crate::schema::{decode_builtin_release, BuiltinRelease};

/// 20 s total budget for both request bodies, mirroring the TS timer.
pub const DOWNLOAD_BUDGET_MS: u64 = 20_000;
/// 10 MB assembled-body cap, mirroring the TS streaming counter.
pub const DOWNLOAD_BODY_LIMIT_BYTES: usize = 10_000_000;

/// One response as the port needs it: the status plus the assembled body.
/// The injected `request` callback fills this in.
#[derive(Debug, Clone)]
pub struct DownloadResponse {
    pub status: u16,
    pub body: String,
}

/// The injected transport. `url` is the fully-built URL; `stage` is
/// `client-config` or `cdn` so the error taxonomy can name the failing stage.
pub type DownloadRequest = dyn Fn(&str, &str) -> Result<DownloadResponse, DownloadRequestError>;

/// A transport-level failure that is NOT an HTTP status — i.e. the request
/// itself failed or was aborted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadRequestError {
    Timeout,
    Cancelled,
    Transport(String),
}

impl DownloadRequestError {
    fn reason(&self) -> String {
        match self {
            DownloadRequestError::Timeout => "timeout".to_string(),
            DownloadRequestError::Cancelled => "cancelled".to_string(),
            DownloadRequestError::Transport(_) => "invalid response".to_string(),
        }
    }
}

/// What the boundary produced.
#[derive(Debug, Clone)]
pub enum DownloadOutcome {
    /// The control plane published no builtin config for this environment.
    None,
    Release(Box<BuiltinRelease>),
}

#[derive(Debug, Clone)]
pub struct DownloadOptions<'a> {
    pub endpoint_origin: &'a str,
    pub app_version: &'a str,
    pub platform: &'a str,
}

/// `downloadZCodeBuiltinRelease`.
pub fn download_builtin_release(
    options: &DownloadOptions<'_>,
    request: &DownloadRequest,
) -> Result<DownloadOutcome, String> {
    let url = client_config_url(options.endpoint_origin, options.app_version, options.platform)
        .map_err(|error| format!("ZCode Built-in client-config: {error}"))?;
    let payload = read_json(&url, "client-config", request)?;
    let download_url = match builtin_provider_config_url(&payload) {
        Ok(Some(url)) => url,
        // The control plane published no builtin config for this environment.
        Ok(None) => return Ok(DownloadOutcome::None),
        Err(error) => return Err(format!("ZCode Built-in client-config: {error}")),
    };
    let release = read_json(&download_url, "cdn", request)?;
    let decoded = decode_builtin_release(&release)
        .map_err(|error| format!("ZCode Built-in cdn: invalid schema at config ({error})"))?;
    Ok(DownloadOutcome::Release(Box::new(decoded)))
}

/// `new URL("/api/v1/client/configs", origin)` + the two query params.
fn client_config_url(
    endpoint_origin: &str,
    app_version: &str,
    platform: &str,
) -> Result<String, String> {
    let base = url::Url::parse(endpoint_origin.trim())
        .map_err(|error| format!("invalid endpoint origin: {error}"))?;
    let mut url = base
        .join("/api/v1/client/configs")
        .map_err(|error| format!("invalid client-config URL: {error}"))?;
    url.query_pairs_mut()
        .append_pair("app_version", app_version)
        .append_pair("platform", platform);
    Ok(url.to_string())
}

/// Extracts and validates `data.configs.builtin_provider_config_json` from the
/// client-config payload. `Ok(None)` = key absent (no builtin config published).
/// The refinement is the TS `.refine`: https, no embedded credentials.
fn builtin_provider_config_url(payload: &serde_json::Value) -> Result<Option<String>, String> {
    let object = payload
        .as_object()
        .ok_or_else(|| "invalid schema at root (invalid_type)".to_string())?;
    match object.get("code").and_then(|value| value.as_i64()) {
        Some(0) => {}
        Some(other) => return Err(format!("invalid schema at code ({other})")),
        None => return Err("invalid schema at code (invalid_type)".to_string()),
    }
    let data = object
        .get("data")
        .and_then(|value| value.as_object())
        .ok_or_else(|| "invalid schema at data (invalid_type)".to_string())?;
    let configs = data
        .get("configs")
        .and_then(|value| value.as_object())
        .ok_or_else(|| "invalid schema at data.configs (invalid_type)".to_string())?;
    let Some(url) = configs
        .get("builtin_provider_config_json")
        .and_then(|value| value.as_str())
    else {
        return Ok(None);
    };
    let parsed = url::Url::parse(url)
        .map_err(|_| "invalid schema at data.configs.builtin_provider_config_json (invalid_url)".to_string())?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(
            "invalid schema at data.configs.builtin_provider_config_json (invalid_url)".into(),
        );
    }
    Ok(Some(url.to_string()))
}

/// One `readJson`: request → status gate → body cap → JSON parse.
fn read_json(
    url: &str,
    stage: &str,
    request: &DownloadRequest,
) -> Result<serde_json::Value, String> {
    let response = request(url, stage).map_err(|error| {
        format!(
            "ZCode Built-in {stage}: {}",
            error.reason()
        )
    })?;
    if !(200..300).contains(&response.status) {
        return Err(format!("ZCode Built-in {stage}: HTTP {}", response.status));
    }
    if response.body.is_empty() {
        return Err(format!("ZCode Built-in {stage}: empty body"));
    }
    if response.body.len() > DOWNLOAD_BODY_LIMIT_BYTES {
        return Err(format!("ZCode Built-in {stage}: body limit exceeded"));
    }
    serde_json::from_str(&response.body)
        .map_err(|_| format!("ZCode Built-in {stage}: invalid schema at root (invalid_json)"))
}

#[cfg(test)]
mod tests {
    use super::*;
        const RELEASE: &str = include_str!("../tests/_fixture_canonical_builtin.json");

    fn ok(body: String) -> DownloadResponse {
        DownloadResponse { status: 200, body }
    }

    fn client_config_with(url: Option<&str>) -> String {
        let mut configs = serde_json::Map::new();
        if let Some(url) = url {
            configs.insert(
                "builtin_provider_config_json".to_string(),
                serde_json::Value::String(url.to_string()),
            );
        }
        serde_json::json!({ "code": 0, "data": { "configs": configs } }).to_string()
    }

    #[test]
    fn a_full_two_step_download_returns_the_release() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = std::sync::Arc::clone(&calls);
        let release = RELEASE.to_string();
        let request = move |url: &str, stage: &str| {
            recorded
                .lock()
                .unwrap()
                .push((url.to_string(), stage.to_string()));
            Ok::<_, DownloadRequestError>(if stage == "client-config" {
                ok(client_config_with(Some("https://cdn.example.com/zcode-builtin.json")))
            } else {
                ok(release.clone())
            })
        };
        let outcome = download_builtin_release(
            &DownloadOptions {
                endpoint_origin: "https://api.z.ai",
                app_version: "1.2.3",
                platform: "linux-x86_64",
            },
            &request,
        )
        .expect("download");
        let DownloadOutcome::Release(release) = outcome else {
            panic!("expected a release");
        };
        assert_eq!(release.revision, 32);
        let calls = calls.lock().unwrap().clone();
        assert_eq!(
            calls[0].0,
            "https://api.z.ai/api/v1/client/configs?app_version=1.2.3&platform=linux-x86_64"
        );
        assert_eq!(calls[1].0, "https://cdn.example.com/zcode-builtin.json");
    }

    #[test]
    fn an_absent_key_means_no_release_not_an_error() {
        let request =
            |_: &str, _: &str| Ok::<_, DownloadRequestError>(ok(client_config_with(None)));
        let outcome = download_builtin_release(
            &DownloadOptions {
                endpoint_origin: "https://api.z.ai",
                app_version: "1.2.3",
                platform: "linux-x86_64",
            },
            &request,
        )
        .expect("download");
        assert!(matches!(outcome, DownloadOutcome::None));
    }

    #[test]
    fn the_error_taxonomy_is_reproduced_per_stage() {
        let cases: Vec<(&str, DownloadRequestError, &str)> = vec![
            (
                "client-config",
                DownloadRequestError::Timeout,
                "ZCode Built-in client-config: timeout",
            ),
            (
                "client-config",
                DownloadRequestError::Cancelled,
                "ZCode Built-in client-config: cancelled",
            ),
            (
                "cdn",
                DownloadRequestError::Transport("socket hang up".into()),
                "ZCode Built-in cdn: invalid response",
            ),
        ];
        for (stage, error, expected) in cases {
            let stage_name = stage.to_string();
            let request = move |_: &str, requested: &str| {
                if requested == "client-config" && stage_name == "cdn" {
                    // The CDN stage only runs after the control plane answered.
                    return Ok::<_, DownloadRequestError>(ok(client_config_with(Some(
                        "https://cdn.example.com/x.json",
                    ))));
                }
                Err::<DownloadResponse, _>(error.clone())
            };
            let message = download_builtin_release(
                &DownloadOptions {
                    endpoint_origin: "https://api.z.ai",
                    app_version: "1.2.3",
                    platform: "linux-x86_64",
                },
                &request,
            )
            .expect_err("must fail");
            assert_eq!(message, expected);
        }
    }

    #[test]
    fn http_status_and_body_cap_are_reported() {
        let status_request =
            |_: &str, _: &str| Ok::<_, DownloadRequestError>(DownloadResponse { status: 503, body: String::new() });
        let message = download_builtin_release(
            &DownloadOptions {
                endpoint_origin: "https://api.z.ai",
                app_version: "1",
                platform: "p",
            },
            &status_request,
        )
        .expect_err("must fail");
        assert_eq!(message, "ZCode Built-in client-config: HTTP 503");

        let empty_request = |_: &str, _: &str| Ok::<_, DownloadRequestError>(ok(String::new()));
        let message = download_builtin_release(
            &DownloadOptions {
                endpoint_origin: "https://api.z.ai",
                app_version: "1",
                platform: "p",
            },
            &empty_request,
        )
        .expect_err("must fail");
        assert_eq!(message, "ZCode Built-in client-config: empty body");

        let huge_request = |_: &str, _: &str| {
            Ok::<_, DownloadRequestError>(ok("x".repeat(DOWNLOAD_BODY_LIMIT_BYTES + 1)))
        };
        let message = download_builtin_release(
            &DownloadOptions {
                endpoint_origin: "https://api.z.ai",
                app_version: "1",
                platform: "p",
            },
            &huge_request,
        )
        .expect_err("must fail");
        assert_eq!(message, "ZCode Built-in client-config: body limit exceeded");
    }

    #[test]
    fn a_non_https_or_credentialed_cdn_url_is_rejected() {
        for url in [
            "http://cdn.example.com/x.json",
            "https://user:pw@cdn.example.com/x.json",
            "not-a-url",
        ] {
            let payload = client_config_with(Some(url));
            let request = move |_: &str, _: &str| Ok::<_, DownloadRequestError>(ok(payload.clone()));
            let message = download_builtin_release(
                &DownloadOptions {
                    endpoint_origin: "https://api.z.ai",
                    app_version: "1",
                    platform: "p",
                },
                &request,
            )
            .expect_err("must fail");
            assert_eq!(
                message,
                "ZCode Built-in client-config: invalid schema at data.configs.builtin_provider_config_json (invalid_url)"
            );
        }
    }

    #[test]
    fn a_retired_zapi_release_is_refused_at_the_cdn_stage() {
        let release = r#"{"schemaVersion":1,"revision":9,"config":{"providerConfigRules":{"templateRules":[],"providerRules":[{"providerId":"builtin:zapi","config":{}}]},"modelConfigRules":{"modelRules":[],"modelApiRules":[],"providerSiteRules":[],"templateModelRules":[],"builtinProviderModelRules":[]}}}"#.to_string();
        let request = move |_: &str, stage: &str| {
            Ok::<_, DownloadRequestError>(if stage == "client-config" {
                ok(client_config_with(Some("https://cdn.example.com/x.json")))
            } else {
                ok(release.clone())
            })
        };
        let message = download_builtin_release(
            &DownloadOptions {
                endpoint_origin: "https://api.z.ai",
                app_version: "1",
                platform: "p",
            },
            &request,
        )
        .expect_err("must fail");
        assert!(message.starts_with("ZCode Built-in cdn: invalid schema"), "{message}");
    }
}
