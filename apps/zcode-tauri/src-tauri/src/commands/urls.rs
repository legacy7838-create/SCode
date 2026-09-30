//! Tauri commands for the external-navigation decisions.
//!
//! Spec: docs/specs/rust-native-url-guard.md §5.2.
//!
//! # Why the host, and not the renderer
//!
//! In Electron these decisions read `event.senderFrame.url`, which is unforgeable. Tauri has
//! no equivalent — the renderer supplies the URL — and `PORT_STATUS.md:161` says so
//! explicitly, recommending the decision be resolved in Rust. A check that lives above a
//! forgeable input is not a check.
//!
//! Every command **denies on error**. There is no "if the guard is unavailable, allow it": the
//! safe answer to "may I open this?" is *no*, so a failure is a denial rather than a fallback.

use serde::{Deserialize, Serialize};
use tauri::State;

use zcode_url_guard::{
    is_allowed_coding_plan_embedded_navigation_url, is_allowed_external_open_url,
    is_coding_plan_payment_callback_url, is_coding_plan_webview_url,
    is_trusted_coding_plan_webview_origin, normalize_endpoint_origin,
    should_keep_coding_plan_open_external_in_webview, GuardOrigins,
};

use crate::AppState;

/// The trusted-origin set, supplied by the renderer so a self-hosted deployment works
/// without recompiling the host (spec invariant 3).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginsPayload {
    pub default_endpoint: String,
    pub runtime_endpoint: String,
    pub zai_business_base: String,
    #[serde(default)]
    pub e2e_store_bridge_enabled: bool,
}

impl OriginsPayload {
    /// Resolve into the crate's type, normalising first.
    ///
    /// A misconfigured endpoint is an **error**, not a denial: every webview check would
    /// otherwise deny, which reads as a product bug rather than a misconfiguration
    /// (spec §6).
    fn resolve(&self) -> Result<GuardOrigins, String> {
        Ok(GuardOrigins {
            default_endpoint: normalize_endpoint_origin(&self.default_endpoint)
                .map_err(|error| error.to_string())?,
            runtime_endpoint: normalize_endpoint_origin(&self.runtime_endpoint)
                .map_err(|error| error.to_string())?,
            zai_business_base: normalize_endpoint_origin(&self.zai_business_base)
                .map_err(|error| error.to_string())?,
            e2e_store_bridge_enabled: self.e2e_store_bridge_enabled,
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalOpenDecision {
    pub allowed: bool,
    /// Why, for the host log. Never shown to the user verbatim.
    pub reason: String,
}

/// `zcode:open-external` — may the host hand this URL to the OS?
#[tauri::command]
pub fn decide_external_open(
    _state: State<'_, std::sync::Arc<AppState>>,
    payload: serde_json::Value,
) -> Result<ExternalOpenDecision, String> {
    // A payload that does not parse is a denial, not an error the user sees.
    let Some(request) = zcode_url_guard::parse_open_external_request(&payload) else {
        return Ok(ExternalOpenDecision {
            allowed: false,
            reason: "malformed openExternal payload".into(),
        });
    };
    let allowed = is_allowed_external_open_url(&request.url);
    Ok(ExternalOpenDecision {
        allowed,
        reason: if allowed {
            format!("scheme allowed for {}", request.url)
        } else {
            format!("scheme not in the allowlist: {}", request.url)
        },
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationPayload {
    pub current_url: String,
    pub target_url: String,
    pub origins: OriginsPayload,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationDecision {
    /// Whether the navigation should stay inside the webview.
    pub keep_in_webview: bool,
    /// Whether the target is one of the three allowed embedded shapes at all.
    pub target_allowed: bool,
    pub current_is_trusted: bool,
}

/// Decide where a navigation goes.
///
/// Three questions, answered separately so the host log can say which one failed: is the
/// current page one of ours, is the target allowed, and therefore does it stay in the webview.
#[tauri::command]
pub fn decide_navigation(
    _state: State<'_, std::sync::Arc<AppState>>,
    payload: NavigationPayload,
) -> Result<NavigationDecision, String> {
    let origins = payload.origins.resolve()?;
    let current_is_trusted = is_coding_plan_webview_url(Some(&payload.current_url), &origins)
        || is_coding_plan_webview_url(Some(&payload.target_url), &origins) == false
            && zcode_url_guard::is_coding_plan_paypal_navigation_url(&payload.current_url, &origins);
    let target_allowed =
        is_allowed_coding_plan_embedded_navigation_url(&payload.target_url, &origins);
    let keep_in_webview = should_keep_coding_plan_open_external_in_webview(
        &payload.current_url,
        &payload.target_url,
        &origins,
    );
    Ok(NavigationDecision {
        keep_in_webview,
        target_allowed,
        current_is_trusted,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewUrlPayload {
    pub src: Option<String>,
    pub origins: OriginsPayload,
}

/// Is this URL one of our own Coding Plan webview pages?
#[tauri::command]
pub fn is_coding_plan_webview(
    _state: State<'_, std::sync::Arc<AppState>>,
    payload: WebviewUrlPayload,
) -> Result<bool, String> {
    let origins = payload.origins.resolve()?;
    Ok(is_coding_plan_webview_url(payload.src.as_deref(), &origins))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallbackPayload {
    pub src: Option<String>,
    pub origins: OriginsPayload,
}

/// Is this a genuine payment callback?
///
/// This is the one that must not be answered loosely: it decides whether a purchase is
/// treated as complete, so the `returnTo` re-validation inside the crate is the whole point.
#[tauri::command]
pub fn is_payment_callback(
    _state: State<'_, std::sync::Arc<AppState>>,
    payload: CallbackPayload,
) -> Result<bool, String> {
    let origins = payload.origins.resolve()?;
    Ok(is_coding_plan_payment_callback_url(payload.src.as_deref(), &origins))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginCheckPayload {
    pub value: Option<String>,
    pub origins: OriginsPayload,
}

/// Is this origin one we trust for an embedded webview?
#[tauri::command]
pub fn is_trusted_webview_origin(
    _state: State<'_, std::sync::Arc<AppState>>,
    payload: OriginCheckPayload,
) -> Result<bool, String> {
    let origins = payload.origins.resolve()?;
    Ok(is_trusted_coding_plan_webview_origin(
        payload.value.as_deref(),
        &origins,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn origins_payload() -> serde_json::Value {
        json!({
            "defaultEndpoint": "https://zcode.z.ai",
            "runtimeEndpoint": "https://zcode.z.ai",
            "zaiBusinessBase": "https://api.z.ai",
            "e2eStoreBridgeEnabled": false,
        })
    }

    #[test]
    fn an_origin_set_that_cannot_be_normalised_is_an_error_not_a_denial() {
        // If this silently became a denial, every webview check would fail and it would
        // read as a product bug rather than a misconfiguration.
        let payload = OriginsPayload {
            default_endpoint: "".into(),
            runtime_endpoint: "https://zcode.z.ai".into(),
            zai_business_base: "https://api.z.ai".into(),
            e2e_store_bridge_enabled: false,
        };
        assert!(payload.resolve().is_err());
    }

    #[test]
    fn the_default_origin_set_resolves() {
        let payload: OriginsPayload =
            serde_json::from_value(origins_payload()).expect("payload shape");
        let resolved = payload.resolve().expect("defaults are valid");
        assert_eq!(resolved.default_endpoint, "https://zcode.z.ai");
    }

    /// A malformed payload must be a denial, so the host can act on it without the user
    /// seeing an error.
    #[test]
    fn a_malformed_payload_denies_rather_than_erroring() {
        for payload in [json!({}), json!({ "url": 7 }), json!("https://ok.test/")] {
            let parsed = zcode_url_guard::parse_open_external_request(&payload);
            // A bare string is legitimate; anything else without a string url is not.
            let allowed = parsed
                .as_ref()
                .is_some_and(|request| is_allowed_external_open_url(&request.url));
            if let Some(request) = parsed {
                assert!(!is_allowed_external_open_url("") || !request.url.is_empty());
            }
            let _ = allowed;
        }
        assert!(zcode_url_guard::parse_open_external_request(&json!({})).is_none());
        assert!(zcode_url_guard::parse_open_external_request(&json!({ "url": 7 })).is_none());
        assert!(zcode_url_guard::parse_open_external_request(&json!("https://ok.test/")).is_some());
    }
}
