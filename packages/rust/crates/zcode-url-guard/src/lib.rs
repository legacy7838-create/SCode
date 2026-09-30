//! External-navigation and payment-callback allowlists.
//!
//! Spec: docs/specs/rust-native-url-guard.md.
//! Ported from `packages/desktop/src/main/desktopMainIpcRemote.ts:38-142` and the origin
//! helpers in `packages/shared/src/zcodeEndpoint.ts`.
//!
//! # Why this is security code and not string handling
//!
//! The Coding Plan flow opens a webview, navigates it to PayPal, and accepts a payment
//! callback. In Electron the URL came from `event.senderFrame.url`, which is unforgeable. Tauri
//! has no equivalent, so the renderer supplies it — and `PORT_STATUS.md:161` says so explicitly,
//! recommending the decision be resolved in Rust. That is what this module is.
//!
//! Two rules must not be "simplified", and both have adversarial fixtures:
//!
//! 1. **The PayPal host test is exact-or-subdomain**, never `contains`. `contains` accepts
//!    `https://evil.com/?x=paypal.com` and `https://paypal.com.evil.com/`.
//! 2. **`returnTo` is re-validated, not merely origin-matched.** It is resolved against the
//!    callback's own origin and then has to independently pass
//!    [`is_coding_plan_webview_url`]. An origin-only check accepts
//!    `?returnTo=/coding-plan/x?embedded=app` aimed at an attacker's page.
//!
//! Every allow rule has a matching denial in the tests. A false accept compromises a payment
//! flow; a false reject is a user who cannot pay.

use url::Url;

/// The default endpoint origin (`zcodeEndpoint.ts:3`).
pub const DEFAULT_ZCODE_ENDPOINT_ORIGIN: &str = "https://zcode.z.ai";
/// The Z.ai business base URL (`zcodeEndpoint.ts:6`).
pub const DEFAULT_ZAI_BUSINESS_BASE_URL: &str = "https://api.z.ai";

/// The trusted-origin set, supplied by the caller rather than baked in.
///
/// The endpoints are resolved by the existing TypeScript helpers from the environment, so a
/// self-hosted deployment keeps working without recompiling — and a test can pin the set.
/// `e2e_store_bridge_enabled` comes from the **build**, not from a runtime flag a user can set
/// (spec R4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardOrigins {
    pub default_endpoint: String,
    /// The runtime-resolved endpoint origin. Equal to `default_endpoint` when unset.
    pub runtime_endpoint: String,
    /// The Z.ai business base URL, already normalised.
    pub zai_business_base: String,
    pub e2e_store_bridge_enabled: bool,
}

impl Default for GuardOrigins {
    fn default() -> Self {
        GuardOrigins {
            default_endpoint: DEFAULT_ZCODE_ENDPOINT_ORIGIN.to_string(),
            runtime_endpoint: DEFAULT_ZCODE_ENDPOINT_ORIGIN.to_string(),
            zai_business_base: DEFAULT_ZAI_BUSINESS_BASE_URL.to_string(),
            e2e_store_bridge_enabled: false,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum OriginError {
    Empty,
    NotHttp,
    Unparsable { value: String, reason: String },
}

impl std::fmt::Display for OriginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OriginError::Empty => write!(f, "ZCode endpoint origin is empty"),
            OriginError::NotHttp => write!(f, "ZCode endpoint origin must use http or https"),
            OriginError::Unparsable { value, reason } => {
                write!(f, "ZCode endpoint origin {value:?} is not a URL: {reason}")
            }
        }
    }
}

impl std::error::Error for OriginError {}

/// `normalizeZCodeEndpointOrigin` (`zcodeEndpoint.ts:87-98`).
///
/// The two failure cases are kept as errors rather than folded into a denial, so a
/// misconfigured endpoint is loud at startup instead of making every webview check deny — which
/// would look like a product bug rather than a misconfiguration (spec §6).
pub fn normalize_endpoint_origin(value: &str) -> Result<String, OriginError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(OriginError::Empty);
    }
    let parsed = Url::parse(trimmed).map_err(|error| OriginError::Unparsable {
        value: trimmed.to_string(),
        reason: error.to_string(),
    })?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(OriginError::NotHttp);
    }
    origin_of(&parsed)
}

/// `url.origin` for a parsed URL, computed the way `URL.origin` does: scheme, host and a
/// **non-default** port. `https://host:443/x` and `https://host/x` share an origin, which is
/// what makes the `returnTo` comparison sound.
fn origin_of(url: &Url) -> Result<String, OriginError> {
    let host = url.host_str().ok_or_else(|| OriginError::Unparsable {
        value: url.as_str().to_string(),
        reason: "no host".to_string(),
    })?;
    match url.port() {
        Some(port) => Ok(format!("{}://{host}:{port}", url.scheme())),
        None => Ok(format!("{}://{host}", url.scheme())),
    }
}

fn is_loopback_hostname(hostname: &str) -> bool {
    // `zcodeEndpoint.ts:100-102` — the host string, which for `[::1]` carries the brackets.
    hostname == "localhost" || hostname == "127.0.0.1" || hostname == "[::1]" || hostname == "::1"
}

/// `isTrustedCodingPlanWebviewOrigin` (`zcodeEndpoint.ts:104-140`).
pub fn is_trusted_coding_plan_webview_origin(
    value: Option<&str>,
    origins: &GuardOrigins,
) -> bool {
    let Some(value) = value else { return false };
    let Ok(origin) = normalize_endpoint_origin(value) else {
        return false;
    };
    if origin == origins.default_endpoint || origin == origins.runtime_endpoint {
        return true;
    }
    // The loopback allowance is behind the build flag, so it cannot be switched on at runtime.
    match Url::parse(&origin) {
        Ok(parsed) => {
            origins.e2e_store_bridge_enabled
                && parsed.host_str().is_some_and(is_loopback_hostname)
        }
        Err(_) => false,
    }
}

/// `isAllowedExternalOpenUrl` (`desktopMainIpcRemote.ts:38-46`).
///
/// A scheme allowlist. `file:` is permitted because the app opens local paths; everything
/// else — `javascript:`, `data:`, `vbscript:`, `about:` — is denied.
pub fn is_allowed_external_open_url(value: &str) -> bool {
    match Url::parse(value) {
        Ok(url) => matches!(url.scheme(), "http" | "https" | "file"),
        Err(_) => false,
    }
}

/// `isPaypalHostname` (`desktopMainIpcRemote.ts:69-71`).
///
/// Exact host or a `.paypal.com` subdomain. **Never `contains`** — see the module docs.
pub fn is_paypal_hostname(hostname: &str) -> bool {
    hostname == "paypal.com" || hostname.ends_with(".paypal.com")
}

/// `isCodingPlanPaypalNavigationUrl` (`desktopMainIpcRemote.ts:73-85`).
pub fn is_coding_plan_paypal_navigation_url(url: &str, origins: &GuardOrigins) -> bool {
    let Ok(parsed) = Url::parse(url) else { return false };
    if parsed.scheme() != "https" {
        return false;
    }
    if parsed.host_str().is_some_and(is_paypal_hostname) {
        return true;
    }
    let Ok(origin) = origin_of(&parsed) else { return false };
    (origin == origins.zai_business_base || origin == "https://api.z.ai")
        && parsed.path().starts_with("/api/pay/paypal/")
}

/// `isCodingPlanWebviewUrl` (`desktopMainIpcRemote.ts:87-104`).
///
/// The `coding-plan` test is on the **pathname only** (`includes`). Testing the whole URL would
/// let a query parameter satisfy it, which is why this is not `url.as_str().contains(...)`.
pub fn is_coding_plan_webview_url(src: Option<&str>, origins: &GuardOrigins) -> bool {
    let Some(src) = src.filter(|value| !value.is_empty()) else {
        return false;
    };
    let Ok(parsed) = Url::parse(src) else { return false };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return false;
    }
    let Ok(origin) = origin_of(&parsed) else { return false };
    if !is_trusted_coding_plan_webview_origin(Some(&origin), origins) {
        return false;
    }
    if !parsed.path().contains("coding-plan") {
        return false;
    }
    // `URLSearchParams.get("embedded") === "app"` — an exact match, so `embedded=apple` and
    // `embedded=1` are both denied.
    query_param(&parsed, "embedded").as_deref() == Some("app")
}

/// `isCodingPlanPaymentCallbackUrl` (`desktopMainIpcRemote.ts:106-126`).
///
/// The `returnTo` re-validation is the open-redirect guard. Both conditions are required:
/// the resolved origin must still equal the callback's, **and** the result must
/// independently pass [`is_coding_plan_webview_url`].
pub fn is_coding_plan_payment_callback_url(src: Option<&str>, origins: &GuardOrigins) -> bool {
    let Some(src) = src.filter(|value| !value.is_empty()) else {
        return false;
    };
    let Ok(parsed) = Url::parse(src) else { return false };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return false;
    }
    let Ok(origin) = origin_of(&parsed) else { return false };
    if !is_trusted_coding_plan_webview_origin(Some(&origin), origins) {
        return false;
    }
    if !parsed.path().ends_with("/coding-plan/payment/callback") {
        return false;
    }
    let Some(return_to) = query_param(&parsed, "returnTo").filter(|v| !v.is_empty()) else {
        return false;
    };
    // `new URL(returnTo, url.origin)` — a *relative* reference resolved against the origin.
    let base = match Url::parse(&origin) {
        Ok(base) => base,
        Err(_) => return false,
    };
    let Ok(target) = base.join(&return_to) else { return false };
    let Ok(target_origin) = origin_of(&target) else { return false };
    target_origin == origin && is_coding_plan_webview_url(Some(target.as_str()), origins)
}

/// `isAllowedCodingPlanEmbeddedNavigationUrl` (`desktopMainIpcRemote.ts:128-134`).
pub fn is_allowed_coding_plan_embedded_navigation_url(
    url: &str,
    origins: &GuardOrigins,
) -> bool {
    is_coding_plan_webview_url(Some(url), origins)
        || is_coding_plan_paypal_navigation_url(url, origins)
        || is_coding_plan_payment_callback_url(Some(url), origins)
}

/// `shouldKeepCodingPlanOpenExternalInWebview` (`desktopMainIpcRemote.ts:136-141`).
///
/// A navigation stays in the webview only when **both** sides qualify: the page currently
/// loaded is ours, and the target is one we allow. Either side alone is not enough.
pub fn should_keep_coding_plan_open_external_in_webview(
    current_url: &str,
    target_url: &str,
    origins: &GuardOrigins,
) -> bool {
    (is_coding_plan_webview_url(Some(current_url), origins)
        || is_coding_plan_paypal_navigation_url(current_url, origins))
        && is_allowed_coding_plan_embedded_navigation_url(target_url, origins)
}

/// A parsed `openExternal` payload (`parseOpenExternalRequest`, `:52-67`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenExternalRequest {
    /// The page that asked. Absent when the caller sent a bare string.
    pub source_url: Option<String>,
    pub url: String,
}

/// `parseOpenExternalRequest` (`:52-67`).
///
/// A non-string `url` is rejected rather than coerced, and a `sourceUrl` of the wrong type is
/// dropped rather than stringified — the TypeScript does the same, and a caller that
/// distinguished "absent" from "empty" would break if that collapsed.
pub fn parse_open_external_request(payload: &serde_json::Value) -> Option<OpenExternalRequest> {
    match payload {
        serde_json::Value::String(url) => Some(OpenExternalRequest {
            source_url: None,
            url: url.clone(),
        }),
        serde_json::Value::Object(record) => {
            let url = record.get("url")?.as_str()?.to_string();
            Some(OpenExternalRequest {
                source_url: record
                    .get("sourceUrl")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                url,
            })
        }
        _ => None,
    }
}

/// The first value for `key`, percent-decoded, or `None`.
///
/// `URLSearchParams.get` returns the first occurrence and decodes `+` as a space, so a
/// hand-rolled scan that missed either would disagree with the original.
fn query_param(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn origins() -> GuardOrigins {
        GuardOrigins::default()
    }

    // ---- external open: a scheme allowlist ----

    #[test]
    fn external_open_allows_only_three_schemes() {
        for good in [
            "https://example.com/x",
            "http://example.com",
            "file:///tmp/a.txt",
        ] {
            assert!(is_allowed_external_open_url(good), "{good} must be allowed");
        }
        // The schemes that turn an "open a link" into code execution.
        for bad in [
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox(1)",
            "about:blank",
            "chrome://settings",
            "not a url",
            "",
            "   ",
            "ht tp://x",
        ] {
            assert!(!is_allowed_external_open_url(bad), "{bad:?} must be denied");
        }
    }

    // ---- PayPal host: exact or subdomain, never contains ----

    #[test]
    fn the_paypal_host_test_is_exact_or_subdomain() {
        for good in ["paypal.com", "www.paypal.com", "a.b.paypal.com"] {
            assert!(is_paypal_hostname(good), "{good} must match");
        }
        // The shapes a `contains("paypal.com")` rewrite would wrongly accept.
        for bad in [
            "paypal.com.evil.com",
            "evil.com/paypal.com",
            "xpaypal.com",
            "paypal.co",
            "paypal.com ",
            "notpaypal.com",
        ] {
            assert!(!is_paypal_hostname(bad), "{bad:?} must not match");
        }
    }

    #[test]
    fn paypal_navigation_requires_https_and_a_trusted_target() {
        let o = origins();
        for good in [
            "https://www.paypal.com/checkoutnow",
            "https://paypal.com/",
            "https://api.z.ai/api/pay/paypal/create",
        ] {
            assert!(
                is_coding_plan_paypal_navigation_url(good, &o),
                "{good} must be allowed"
            );
        }
        for bad in [
            "http://www.paypal.com/",                       // scheme
            "https://paypal.com.evil.com/",                  // host
            "https://evil.com/api/pay/paypal/create",        // origin
            "https://api.z.ai/api/pay/paypal-evil/create",   // prefix, not a path segment
            "https://api.z.ai/other?x=/api/pay/paypal/",     // the prefix must be in the path
            "not a url",
        ] {
            assert!(
                !is_coding_plan_paypal_navigation_url(bad, &o),
                "{bad:?} must be denied"
            );
        }
    }

    // ---- the webview URL ----

    #[test]
    fn the_webview_url_needs_a_trusted_origin_a_path_and_embedded_app() {
        let o = origins();
        for good in [
            "https://zcode.z.ai/coding-plan?embedded=app",
            "https://zcode.z.ai/app/coding-plan/x?embedded=app&y=1",
        ] {
            assert!(is_coding_plan_webview_url(Some(good), &o), "{good} must be allowed");
        }
        for bad in [
            "https://evil.com/coding-plan?embedded=app",        // untrusted origin
            "https://zcode.z.ai/coding-plan",                   // no embedded
            "https://zcode.z.ai/coding-plan?embedded=1",         // wrong value
            "https://zcode.z.ai/coding-plan?embedded=apple",     // prefix, not exact
            "https://zcode.z.ai/other?x=coding-plan",            // the test is on the path
            "javascript:alert(1)//coding-plan?embedded=app",     // scheme
            "not a url",
            // The scheme check accepts `http`, but the *origin* check then denies it: the
            // default endpoint is `https://zcode.z.ai`, and `http://zcode.z.ai` is a
            // different origin. The two checks compose, and the first one passing does not
            // imply the second will.
            "http://zcode.z.ai/coding-plan?embedded=app",
        ] {
            assert!(
                !is_coding_plan_webview_url(Some(bad), &o),
                "{bad:?} must be denied"
            );
        }
        assert!(!is_coding_plan_webview_url(None, &o));
        assert!(!is_coding_plan_webview_url(Some(""), &o));
    }

    /// `http` *is* reachable, but only when the runtime endpoint is itself http — the
    /// self-hosted and loopback case. That is the composition the previous test pins.
    #[test]
    fn an_http_endpoint_is_trusted_only_when_it_is_the_configured_runtime_origin() {
        let dev = GuardOrigins {
            runtime_endpoint: "http://localhost:5173".to_string(),
            e2e_store_bridge_enabled: true,
            ..GuardOrigins::default()
        };
        assert!(is_coding_plan_webview_url(
            Some("http://localhost:5173/coding-plan?embedded=app"),
            &dev
        ));
    }

    // ---- the payment callback: the open-redirect guard ----

    #[test]
    fn a_payment_callback_requires_a_return_to_that_survives_revalidation() {
        let o = origins();
        for good in [
            "https://zcode.z.ai/coding-plan/payment/callback?returnTo=/coding-plan/done%3Fembedded%3Dapp",
            "https://zcode.z.ai/coding-plan/payment/callback?returnTo=/x/coding-plan?embedded=app",
        ] {
            assert!(
                is_coding_plan_payment_callback_url(Some(good), &o),
                "{good} must be allowed"
            );
        }
        for bad in [
            // Absolute to another origin: the classic open redirect.
            "https://zcode.z.ai/coding-plan/payment/callback?returnTo=https://evil.com/coding-plan?embedded=app",
            // Same origin, but the target is not itself a valid webview URL.
            "https://zcode.z.ai/coding-plan/payment/callback?returnTo=/account",
            // Same origin, right path shape, wrong `embedded` value.
            "https://zcode.z.ai/coding-plan/payment/callback?returnTo=/coding-plan?embedded=1",
            // No returnTo at all.
            "https://zcode.z.ai/coding-plan/payment/callback",
            "https://zcode.z.ai/coding-plan/payment/callback?returnTo=",
            // Wrong callback path.
            "https://zcode.z.ai/coding-plan/other?returnTo=/coding-plan?embedded=app",
            // Untrusted origin.
            "https://evil.com/coding-plan/payment/callback?returnTo=/coding-plan?embedded=app",
            // A javascript: target smuggled through returnTo.
            "https://zcode.z.ai/coding-plan/payment/callback?returnTo=javascript:alert(1)",
        ] {
            assert!(
                !is_coding_plan_payment_callback_url(Some(bad), &o),
                "{bad:?} must be denied"
            );
        }
        assert!(!is_coding_plan_payment_callback_url(None, &o));
    }

    /// The specific attack the two-step check exists for: an origin-only check would accept
    /// this, because the origin *does* match.
    #[test]
    fn an_origin_only_check_would_have_accepted_this() {
        let o = origins();
        let attack = "https://zcode.z.ai/coding-plan/payment/callback?returnTo=/admin";
        // The origin matches...
        let parsed = Url::parse(attack).expect("parses");
        assert_eq!(origin_of(&parsed).unwrap(), o.default_endpoint);
        // ...but the target is not a valid webview URL, so the callback is denied.
        assert!(!is_coding_plan_payment_callback_url(Some(attack), &o));
    }

    // ---- keep-in-webview ----

    #[test]
    fn a_navigation_stays_in_the_webview_only_when_both_sides_qualify() {
        let o = origins();
        let ours = "https://zcode.z.ai/coding-plan?embedded=app";
        let paypal = "https://www.paypal.com/checkoutnow";
        assert!(should_keep_coding_plan_open_external_in_webview(
            ours,
            "https://zcode.z.ai/coding-plan/next?embedded=app",
            &o
        ));
        assert!(should_keep_coding_plan_open_external_in_webview(
            paypal,
            "https://zcode.z.ai/coding-plan/payment/callback?returnTo=/coding-plan?embedded=app",
            &o
        ));
        // Current page is ours but the target is not allowed.
        assert!(!should_keep_coding_plan_open_external_in_webview(
            ours,
            "https://evil.com/",
            &o
        ));
        // Target is allowed but the current page is not ours.
        assert!(!should_keep_coding_plan_open_external_in_webview(
            "https://example.com/",
            "https://zcode.z.ai/coding-plan?embedded=app",
            &o
        ));
        // Unparsable on either side.
        assert!(!should_keep_coding_plan_open_external_in_webview("nope", "nope", &o));
    }

    // ---- trusted origins ----

    #[test]
    fn only_the_configured_origins_are_trusted() {
        let o = origins();
        assert!(is_trusted_coding_plan_webview_origin(Some("https://zcode.z.ai"), &o));
        assert!(is_trusted_coding_plan_webview_origin(Some("https://zcode.z.ai/"), &o));
        assert!(!is_trusted_coding_plan_webview_origin(Some("https://evil.com"), &o));
        assert!(!is_trusted_coding_plan_webview_origin(None, &o));
        assert!(!is_trusted_coding_plan_webview_origin(Some(""), &o));
        assert!(!is_trusted_coding_plan_webview_origin(Some("not a url"), &o));
    }

    /// The loopback allowance is behind the build flag, so it cannot be switched on at runtime.
    #[test]
    fn loopback_is_trusted_only_in_the_e2e_build() {
        let production = origins();
        assert!(!production.e2e_store_bridge_enabled);
        for host in ["http://localhost:5173", "http://127.0.0.1:3000", "http://[::1]:8080"] {
            assert!(
                !is_trusted_coding_plan_webview_origin(Some(host), &production),
                "{host} must not be trusted in a production build"
            );
        }

        let e2e = GuardOrigins {
            e2e_store_bridge_enabled: true,
            ..GuardOrigins::default()
        };
        for host in ["http://localhost:5173", "http://127.0.0.1:3000", "http://[::1]:8080"] {
            assert!(
                is_trusted_coding_plan_webview_origin(Some(host), &e2e),
                "{host} must be trusted in the E2E build"
            );
        }
        // A non-loopback host is still denied even with the flag on.
        assert!(!is_trusted_coding_plan_webview_origin(
            Some("https://evil.com"),
            &e2e
        ));
    }

    /// A self-hosted deployment must work without a recompile, which is why the origins are
    /// inputs rather than constants baked into the crate.
    #[test]
    fn a_self_hosted_runtime_endpoint_is_trusted() {
        let o = GuardOrigins {
            runtime_endpoint: "https://code.internal.example:8443".to_string(),
            ..GuardOrigins::default()
        };
        assert!(is_trusted_coding_plan_webview_origin(
            Some("https://code.internal.example:8443"),
            &o
        ));
        assert!(is_coding_plan_webview_url(
            Some("https://code.internal.example:8443/coding-plan?embedded=app"),
            &o
        ));
    }

    // ---- endpoint normalisation ----

    #[test]
    fn endpoint_normalisation_keeps_the_two_throw_cases() {
        assert_eq!(normalize_endpoint_origin("https://zcode.z.ai").unwrap(), "https://zcode.z.ai");
        assert_eq!(
            normalize_endpoint_origin("  https://zcode.z.ai/ignored-path  ").unwrap(),
            "https://zcode.z.ai",
            "only the origin survives, and it is trimmed"
        );
        // A non-default port is part of the origin.
        assert_eq!(
            normalize_endpoint_origin("http://localhost:5173").unwrap(),
            "http://localhost:5173"
        );
        // A default port is not, which is what makes origin comparison sound.
        assert_eq!(
            normalize_endpoint_origin("https://zcode.z.ai:443").unwrap(),
            "https://zcode.z.ai"
        );

        assert_eq!(normalize_endpoint_origin("").unwrap_err(), OriginError::Empty);
        assert_eq!(normalize_endpoint_origin("   ").unwrap_err(), OriginError::Empty);
        assert_eq!(
            normalize_endpoint_origin("ftp://host").unwrap_err(),
            OriginError::NotHttp
        );
        assert!(matches!(
            normalize_endpoint_origin("javascript:alert(1)").unwrap_err(),
            OriginError::NotHttp
        ));
        assert!(matches!(
            normalize_endpoint_origin("nonsense").unwrap_err(),
            OriginError::Unparsable { .. }
        ));
    }

    // ---- payload parsing ----

    #[test]
    fn an_open_external_payload_is_parsed_without_coercion() {
        assert_eq!(
            parse_open_external_request(&json!("https://x.test/")),
            Some(OpenExternalRequest { source_url: None, url: "https://x.test/".into() })
        );
        assert_eq!(
            parse_open_external_request(&json!({ "url": "https://x.test/", "sourceUrl": "https://y.test/" })),
            Some(OpenExternalRequest {
                source_url: Some("https://y.test/".into()),
                url: "https://x.test/".into()
            })
        );
        // A non-string `sourceUrl` is dropped, not stringified.
        assert_eq!(
            parse_open_external_request(&json!({ "url": "https://x.test/", "sourceUrl": 42 })),
            Some(OpenExternalRequest { source_url: None, url: "https://x.test/".into() })
        );
        // A non-string or absent `url` is rejected outright.
        for bad in [json!({}), json!({ "url": 42 }), json!({ "url": null }), json!(null), json!(7)] {
            assert_eq!(parse_open_external_request(&bad), None, "{bad} must be rejected");
        }
    }

    /// The union rule, which is what the navigation decision actually calls.
    #[test]
    fn the_union_covers_exactly_the_three_allowed_shapes() {
        let o = origins();
        for good in [
            "https://zcode.z.ai/coding-plan?embedded=app",
            "https://www.paypal.com/checkoutnow",
            "https://zcode.z.ai/coding-plan/payment/callback?returnTo=/coding-plan?embedded=app",
        ] {
            assert!(
                is_allowed_coding_plan_embedded_navigation_url(good, &o),
                "{good} must be allowed"
            );
        }
        for bad in [
            "https://zcode.z.ai/",
            "https://example.com/coding-plan?embedded=app",
            "http://www.paypal.com/",
        ] {
            assert!(
                !is_allowed_coding_plan_embedded_navigation_url(bad, &o),
                "{bad:?} must be denied"
            );
        }
    }

    /// The constants the TypeScript declares, pinned so a rename is caught here.
    #[test]
    fn the_default_constants_match_the_shared_package() {
        assert_eq!(DEFAULT_ZCODE_ENDPOINT_ORIGIN, "https://zcode.z.ai");
        assert_eq!(DEFAULT_ZAI_BUSINESS_BASE_URL, "https://api.z.ai");
    }
}
